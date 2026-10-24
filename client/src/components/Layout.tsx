import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import { USING_MOCK_API } from '../api';
import { cx } from '../lib/cx';

const navItem = ({ isActive }: { isActive: boolean }) =>
  cx(
    'flex items-center min-h-12 px-3 md:px-4 text-[0.875rem] no-underline text-ink border-b-[3px]',
    isActive ? 'border-primary font-semibold' : 'border-transparent hover:bg-surface-1',
  );

export function Layout() {
  return (
    <div className="min-h-dvh flex flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-primary focus:text-white focus:px-4 focus:py-3"
      >
        Skip to main content
      </a>
      <header className="sticky top-0 z-20 bg-canvas border-b border-hairline">
        <div className="mx-auto max-w-[66rem] px-4 flex flex-wrap items-center justify-between">
          <NavLink to="/" className="flex items-center gap-2 min-h-12 no-underline text-ink" aria-label="CivicFix home">
            <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" fill="#0f62fe" />
              <path d="M9 16.5l4.5 4.5L23 11.5" fill="none" stroke="#fff" strokeWidth="3" />
            </svg>
            <span>
              Civic<span className="font-semibold">Fix</span>
            </span>
          </NavLink>
          <nav aria-label="Main" className="flex">
            <NavLink to="/report" className={navItem}>
              Report a problem
            </NavLink>
            <NavLink to="/complaints" className={navItem}>
              My complaints
            </NavLink>
          </nav>
        </div>
      </header>
      {USING_MOCK_API && (
        <div className="bg-inverse text-white text-[0.75rem]">
          <p className="mx-auto max-w-[66rem] px-4 py-2">
            Demo mode: sample data only. Nothing is sent to a city department.
          </p>
        </div>
      )}
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <footer className="bg-inverse text-[#c6c6c6] text-[0.75rem]">
        <div className="mx-auto max-w-[66rem] px-4 py-6">CivicFix · Team BitBros, NITK Surathkal · ChronoForge 2026</div>
      </footer>
    </div>
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
      <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
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
