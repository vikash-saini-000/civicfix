import { Link, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import type { Role } from '../api/authTypes';
import { PublicOnlyRoute, RequireAuth, RequireRole } from '../auth/RouteGuards';
import { Layout, Page } from '../components/Layout';
import { ComplaintDetailPage } from '../pages/ComplaintDetailPage';
import { ComplaintsPage } from '../pages/ComplaintsPage';
import { HomePage } from '../pages/HomePage';
import { LoginPage, RegisterPage, RolePlaceholderPage } from '../pages/PlaceholderPages';
import { ReportPage } from '../pages/ReportPage';

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
        <Route path="complaints" element={<Guarded roles={['citizen']}><ComplaintsPage /></Guarded>} />
        <Route path="complaints/:publicId" element={<Guarded roles={['citizen']}><ComplaintDetailPage /></Guarded>} />
        <Route path="citizen/*" element={<Guarded roles={['citizen']}><RolePlaceholderPage role="Citizen" /></Guarded>} />
        <Route path="department/*" element={<Guarded roles={['department_member']}><RolePlaceholderPage role="Department member" /></Guarded>} />
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

function NotFound() {
  return (
    <Page title="Page not found" intro="The page you requested does not exist.">
      <p className="text-ink-muted">
        Check the address or return to the <Link to="/">CivicFix home page</Link>.
      </p>
    </Page>
  );
}
