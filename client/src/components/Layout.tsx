import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { API_MODE, AUTH_MODE, USING_MOCK_API } from '../api';
import { ROLE_LABELS, navigationForRole, type NavigationItem } from '../auth/navigation';
import { useAuth } from '../auth/AuthContext';
import { Badge } from './Badge';
import { Button } from './Button';
import { LoadingIndicator } from './Feedback';
import { Notification } from './Notification';
import { PageMeta } from './PageMeta';
import { cx } from '../lib/cx';

const PUBLIC_NAVIGATION: NavigationItem[] = [
  { label: 'Report a problem', to: '/citizen/complaints/new' },
  { label: 'My complaints', to: '/citizen/complaints' },
  { label: 'Log in', to: '/login' },
];

const navItem = ({ isActive }: { isActive: boolean }) =>
  cx(
    'flex min-h-12 items-center border-b-[3px] px-3 text-[0.875rem] text-ink no-underline transition-colors duration-200 md:px-4',
    isActive ? 'border-primary font-semibold' : 'border-transparent hover:bg-surface-1',
  );

export function Layout() {
  const { state, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavigationRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const previousPathRef = useRef(location.pathname);
  const user = state.status === 'authenticated' ? state.user : null;
  const isAuthenticated = user !== null;
  const navigation = user ? navigationForRole(user.role) : PUBLIC_NAVIGATION;

  useEffect(() => {
    setMobileOpen(false);
    if (previousPathRef.current !== location.pathname) {
      previousPathRef.current = location.pathname;
      window.setTimeout(() => mainRef.current?.focus(), 0);
    }
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    mobileNavigationRef.current?.querySelector<HTMLElement>('a, button')?.focus();
  }, [mobileOpen]);

  async function handleLogout() {
    setIsLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch {
      setLogoutError('We could not sign you out. Please try again.');
    } finally {
      setIsLoggingOut(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only absolute focus:not-sr-only focus:z-50 focus:bg-primary focus:px-4 focus:py-3 focus:text-white"
      >
        Skip to main content
      </a>
      <header className="sticky top-0 z-20 border-b border-hairline bg-canvas">
        <div className="mx-auto flex min-h-12 w-full max-w-[66rem] items-center justify-between gap-4 px-4">
          <NavLink to="/" className="flex min-h-12 shrink-0 items-center gap-2 text-ink no-underline" aria-label="CivicFix home">
            <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" fill="#0f62fe" />
              <path d="M9 16.5l4.5 4.5L23 11.5" fill="none" stroke="#fff" strokeWidth="3" />
            </svg>
            <span>
              Civic<span className="font-semibold">Fix</span>
            </span>
          </NavLink>

          <nav aria-label="Main navigation" className="hidden min-w-0 items-center md:flex">
            {navigation.map((item) => <NavigationLink key={item.to} item={item} />)}
          </nav>

          <div className="flex items-center gap-2">
            {isAuthenticated && user && (
              <div className="hidden items-center gap-3 md:flex">
                <div className="text-right">
                  <p className="max-w-48 truncate text-[0.875rem] font-semibold">{user.displayName}</p>
                  <Badge tone="info">{ROLE_LABELS[user.role]}</Badge>
                </div>
                <Button variant="ghost" size="sm" onClick={handleLogout} disabled={isLoggingOut}>
                  {isLoggingOut ? 'Signing out…' : 'Sign out'}
                </Button>
              </div>
            )}
            <button
              ref={menuButtonRef}
              type="button"
              className="min-h-12 min-w-12 border border-hairline bg-canvas px-3 text-[0.875rem] text-ink hover:bg-surface-1 md:hidden"
              aria-expanded={mobileOpen}
              aria-controls="mobile-navigation"
              aria-label={mobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
              onClick={() => setMobileOpen((value) => !value)}
            >
              {mobileOpen ? 'Close' : 'Menu'}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <nav
            ref={mobileNavigationRef}
            id="mobile-navigation"
            aria-label="Mobile navigation"
            className="border-t border-hairline px-4 pb-3 md:hidden"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setMobileOpen(false);
                menuButtonRef.current?.focus();
              }
            }}
          >
            {navigation.map((item) => <NavigationLink key={item.to} item={item} mobile />)}
            {isAuthenticated && user && (
              <div className="flex items-center justify-between gap-3 border-t border-hairline pt-3">
                <div>
                  <p className="text-[0.875rem] font-semibold">{user.displayName}</p>
                  <Badge tone="info">{ROLE_LABELS[user.role]}</Badge>
                </div>
                <Button variant="ghost" size="sm" onClick={handleLogout} disabled={isLoggingOut}>
                  {isLoggingOut ? 'Signing out…' : 'Sign out'}
                </Button>
              </div>
            )}
          </nav>
        )}
      </header>

      {USING_MOCK_API && (
        <div className="bg-inverse text-[0.75rem] text-white">
          <p className="mx-auto max-w-[66rem] px-4 py-2">
            Development mode: mock data and mock authentication only. Nothing is sent to a city department.
          </p>
        </div>
      )}
      {logoutError && (
        <div className="mx-auto w-full max-w-[66rem] px-4 pt-4">
          <Notification kind="error" title={logoutError} />
        </div>
      )}
      {AUTH_MODE !== API_MODE && (
        <div className="mx-auto w-full max-w-[66rem] px-4 pt-4">
          <Notification kind="error" title="Authentication and API modes are misconfigured." />
        </div>
      )}

      <main id="main" ref={mainRef} tabIndex={-1} className="flex-1">
        <Suspense fallback={<RouteLoading />}>
          <Outlet />
        </Suspense>
      </main>
      <footer className="bg-inverse text-[0.875rem] text-[#c6c6c6]">
        <div className="mx-auto grid max-w-[66rem] gap-10 px-4 py-10 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)] md:py-12">
          <div className="max-w-[24rem]">
            <Link to="/" className="inline-flex items-center gap-2 text-[1.125rem] text-white no-underline">
              <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
                <rect width="32" height="32" fill="#0f62fe" />
                <path d="M9 16.5l4.5 4.5L23 11.5" fill="none" stroke="#fff" strokeWidth="3" />
              </svg>
              <span>Civic<span className="font-semibold">Fix</span></span>
            </Link>
            <p className="mt-4 max-w-[22rem] leading-6">
              A simpler way for residents to report public problems and follow the information available about them.
            </p>
          </div>
          <div>
            <h2 className="text-[0.75rem] font-semibold uppercase tracking-[0.1em] text-white">For citizens</h2>
            <nav aria-label="Citizen footer navigation" className="mt-4 flex flex-col items-start gap-3">
              <Link to="/citizen/complaints/new" className="text-[#c6c6c6] underline-offset-4 hover:text-white hover:underline">Report a problem</Link>
              <Link to="/#track" className="text-[#c6c6c6] underline-offset-4 hover:text-white hover:underline">Track a complaint</Link>
              <Link to="/#how-it-works" className="text-[#c6c6c6] underline-offset-4 hover:text-white hover:underline">How it works</Link>
              <Link to="/login" className="text-[#c6c6c6] underline-offset-4 hover:text-white hover:underline">Log in</Link>
            </nav>
          </div>
          <div>
            <h2 className="text-[0.75rem] font-semibold uppercase tracking-[0.1em] text-white">Good to know</h2>
            <p className="mt-4 leading-6">CivicFix is for non-emergency public problems. For immediate danger, contact your local emergency service.</p>
            <p className="mt-4 text-[0.75rem] text-[#8d8d8d]">Team BitBros · NITK Surathkal · ChronoForge 2026</p>
          </div>
        </div>
        <div className="border-t border-[#393939]">
          <div className="mx-auto max-w-[66rem] px-4 py-4 text-[0.75rem] text-[#8d8d8d]">
            Information shown in CivicFix depends on the connected city workflow and the access available to your account.
          </div>
        </div>
      </footer>
    </div>
  );
}

function NavigationLink({ item, mobile = false }: { item: NavigationItem; mobile?: boolean }) {
  return (
    <NavLink to={item.to} end={item.end} className={({ isActive }) => cx(navItem({ isActive }), mobile && 'w-full')}>
      {item.label}
    </NavLink>
  );
}

export function Page({
  title,
  intro,
  children,
  actions,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[66rem] px-4 py-8 md:py-12">
      <PageMeta title={title} description={typeof intro === 'string' ? intro : undefined} />
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-[42rem]">
          <h1 className="text-[2rem] leading-tight md:text-[2.625rem]">{title}</h1>
          {intro && <p className="mt-3 text-ink-muted">{intro}</p>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

export function PageContainer({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('mx-auto w-full max-w-[66rem] px-4 py-8 md:py-12', className)}>{children}</div>;
}

export function PageHeader({
  title,
  intro,
  actions,
}: {
  title: string;
  intro?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <>
      <PageMeta title={title} description={typeof intro === 'string' ? intro : undefined} />
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-[42rem]">
          <h1 className="text-[2rem] leading-tight md:text-[2.625rem]">{title}</h1>
          {intro && <p className="mt-3 text-ink-muted">{intro}</p>}
        </div>
        {actions}
      </div>
    </>
  );
}

function RouteLoading() {
  return (
    <Page title="Loading CivicFix">
      <LoadingIndicator label="Loading this CivicFix workspace" />
    </Page>
  );
}
