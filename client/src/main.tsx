import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import './index.css';
import { Layout, Page } from './components/Layout';
import { HomePage } from './pages/HomePage';
import { ReportPage } from './pages/ReportPage';
import { ComplaintsPage } from './pages/ComplaintsPage';
import { ComplaintDetailPage } from './pages/ComplaintDetailPage';

function NotFound() {
  return (
    <Page title="Page not found">
      <p className="text-ink-muted">
        That page does not exist. Go to the <Link to="/">home page</Link>.
      </p>
    </Page>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="report" element={<ReportPage />} />
          <Route path="complaints" element={<ComplaintsPage />} />
          <Route path="complaints/:publicId" element={<ComplaintDetailPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
