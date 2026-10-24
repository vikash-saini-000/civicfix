import { lazy, type ReactNode } from 'react';
import { Link, Route, Routes } from 'react-router';
import type { Role } from '../api/authTypes';
import { PublicOnlyRoute, RequireAuth, RequireDepartmentMembership, RequireRole } from '../auth/RouteGuards';
import { Layout, Page } from '../components/Layout';
import { HomePage } from '../pages/HomePage';

const ComplaintDetailPage = lazy(() =>
  import('../pages/ComplaintDetailPage').then(({ ComplaintDetailPage: Component }) => ({ default: Component })),
);
const ComplaintsPage = lazy(() => import('../pages/ComplaintsPage').then(({ ComplaintsPage: Component }) => ({ default: Component })));
const DashboardPage = lazy(() => import('../pages/DashboardPage').then(({ DashboardPage: Component }) => ({ default: Component })));
const DepartmentComplaintDetailPage = lazy(() =>
  import('../pages/DepartmentComplaintDetailPage').then(({ DepartmentComplaintDetailPage: Component }) => ({ default: Component })),
);
const DepartmentComplaintsPage = lazy(() =>
  import('../pages/DepartmentComplaintsPage').then(({ DepartmentComplaintsPage: Component }) => ({ default: Component })),
);
const DepartmentWorkspacePage = lazy(() =>
  import('../pages/DepartmentWorkspacePage').then(({ DepartmentWorkspacePage: Component }) => ({ default: Component })),
);
const LoginPage = lazy(() => import('../pages/PlaceholderPages').then(({ LoginPage: Component }) => ({ default: Component })));
const RegisterPage = lazy(() => import('../pages/PlaceholderPages').then(({ RegisterPage: Component }) => ({ default: Component })));
const RolePlaceholderPage = lazy(() =>
  import('../pages/PlaceholderPages').then(({ RolePlaceholderPage: Component }) => ({ default: Component })),
);
const ReportPage = lazy(() => import('../pages/ReportPage').then(({ ReportPage: Component }) => ({ default: Component })));
const ManagerReviewDetailPage = lazy(() =>
  import('../pages/ManagerReviewPage').then(({ ManagerReviewDetailPage: Component }) => ({ default: Component })),
);
const ManagerReviewPage = lazy(() =>
  import('../pages/ManagerReviewPage').then(({ ManagerReviewPage: Component }) => ({ default: Component })),
);
const NotificationsPage = lazy(() =>
  import('../pages/NotificationsPage').then(({ NotificationsPage: Component }) => ({ default: Component })),
);

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route
          path="login"
          element={
            <PublicOnlyRoute>
              <LoginPage />
            </PublicOnlyRoute>
          }
        />
        <Route
          path="register"
          element={
            <PublicOnlyRoute>
              <RegisterPage />
            </PublicOnlyRoute>
          }
        />
        <Route path="notifications" element={<Authenticated><NotificationsPage /></Authenticated>} />
        <Route path="report" element={<Guarded roles={['citizen']}><ReportPage /></Guarded>} />
        <Route path="citizen/complaints/new" element={<Guarded roles={['citizen']}><ReportPage /></Guarded>} />
        <Route path="citizen/dashboard" element={<Guarded roles={['citizen']}><DashboardPage /></Guarded>} />
        <Route path="citizen/complaints" element={<Guarded roles={['citizen']}><ComplaintsPage /></Guarded>} />
        <Route path="citizen/complaints/:complaintId" element={<Guarded roles={['citizen']}><ComplaintDetailPage /></Guarded>} />
        <Route path="citizen" element={<Guarded roles={['citizen']}><DashboardPage /></Guarded>} />
        <Route path="complaints" element={<Guarded roles={['citizen']}><ComplaintsPage /></Guarded>} />
        <Route path="complaints/:publicId" element={<Guarded roles={['citizen']}><ComplaintDetailPage /></Guarded>} />
        <Route path="citizen/*" element={<Guarded roles={['citizen']}><RolePlaceholderPage role="Citizen" /></Guarded>} />
        <Route path="department" element={<DepartmentGuard><DepartmentWorkspacePage /></DepartmentGuard>} />
        <Route path="department/complaints" element={<DepartmentGuard><DepartmentComplaintsPage /></DepartmentGuard>} />
        <Route path="department/complaints/:complaintId" element={<DepartmentGuard><DepartmentComplaintDetailPage /></DepartmentGuard>} />
        <Route path="department/*" element={<DepartmentGuard><RolePlaceholderPage role="Department member" /></DepartmentGuard>} />
        <Route path="manager/review/:complaintId" element={<Guarded roles={['department_manager']}><ManagerReviewDetailPage /></Guarded>} />
        <Route path="manager/review" element={<Guarded roles={['department_manager']}><ManagerReviewPage /></Guarded>} />
        <Route path="manager/*" element={<Guarded roles={['department_manager']}><RolePlaceholderPage role="Department manager" /></Guarded>} />
        <Route path="admin/*" element={<Guarded roles={['platform_admin']}><RolePlaceholderPage role="Platform administrator" /></Guarded>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function Guarded({ roles, children }: { roles: Role[]; children: ReactNode }) {
  return (
    <RequireAuth>
      <RequireRole roles={roles}>{children}</RequireRole>
    </RequireAuth>
  );
}

function Authenticated({ children }: { children: ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}

function DepartmentGuard({ children }: { children: ReactNode }) {
  return (
    <Guarded roles={['department_member', 'department_manager']}>
      <RequireDepartmentMembership>{children}</RequireDepartmentMembership>
    </Guarded>
  );
}

function NotFound() {
  return (
    <Page title="Page not found" intro="The page you requested does not exist.">
      <p className="text-ink-muted">
        Check the address or return to the <Link to="/">CivicFix home page</Link>.
      </p>
    </Page>
  );
}
