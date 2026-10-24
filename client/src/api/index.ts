import { mockApi } from './mockApi';
import type { CivicFixApi } from './types';

// Mock data until the backend (Postgres + Express) exposes /api/v1/complaints.
export const api: CivicFixApi = mockApi;
export const USING_MOCK_API = true;
