import { Link, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import type { Role } from '../api/authTypes';
import { PublicOnlyRoute, RequireAuth, RequireDepartmentMembership, RequireRole } from '../auth/RouteGuards';
import { Layout, Page } from '../components/Layout';
import { ComplaintDetailPage } from '../pages/ComplaintDetailPage';
import { ComplaintsPage } from '../pages/ComplaintsPage';
import { DashboardPage } from '../pages/DashboardPage';
import { DepartmentComplaintDetailPage } from '../pages/DepartmentComplaintDetailPage';
import { DepartmentComplaintsPage } from '../pages/DepartmentComplaintsPage';
import { DepartmentWorkspacePage } from '../pages/DepartmentWorkspacePage';
import { HomePage } from '../pages/HomePage';
import { LoginPage, RegisterPage, RolePlaceholderPage } from '../pages/PlaceholderPages';
import { ReportPage } from '../pages/ReportPage';
import { ManagerReviewDetailPage, ManagerReviewPage } from '../pages/ManagerReviewPage';

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
