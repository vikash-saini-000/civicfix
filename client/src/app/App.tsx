import { BrowserRouter } from 'react-router';
import { api } from '../api';
import { AuthProvider } from '../auth/AuthContext';
import { AppRoutes } from './router';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider authApi={api}>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
