import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { useAuth } from './AuthContext';
import { membershipsForUser, selectDepartmentContext } from './department';

export function useDepartmentContext() {
  const { state } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const user = state.user;
  const memberships = useMemo(() => (user ? membershipsForUser(user) : []), [user]);
  const requestedDepartmentId = searchParams.get('department');
  const context = useMemo(
    () => (user ? selectDepartmentContext(user, requestedDepartmentId) : null),
    [requestedDepartmentId, user],
  );

  const selectDepartment = useCallback(
    (departmentId: string) => {
      if (!memberships.some((membership) => membership.departmentId === departmentId)) return;
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.set('department', departmentId);
        return next;
      });
    },
    [memberships, setSearchParams],
  );

  return { context, memberships, selectDepartment, hasInvalidRequestedContext: Boolean(requestedDepartmentId && !context) };
}
