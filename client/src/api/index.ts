import { getApiConfig, getAuthConfig, type ApiConfig, type AuthConfig } from './config';
import { HttpCivicFixApi } from './httpApi';
import { createMockApi } from './mockApi';
import { createMockAuthApi } from './mockAuthApi';
import { createMockOperationsApi } from './mockOperationsApi';
import type { CivicFixApi } from './types';

const config = getApiConfig();
const authConfig = getAuthConfig(config);

export function createConfiguredApi(apiConfig: ApiConfig, configuredAuth: AuthConfig = { mode: apiConfig.mode }): CivicFixApi {
  if (apiConfig.mode !== configuredAuth.mode) {
    throw new Error('API and authentication adapters must use the same mode.');
  }
  if (apiConfig.mode === 'mock') {
    return { ...createMockApi(), ...createMockAuthApi(), ...createMockOperationsApi() };
  }
  return new HttpCivicFixApi({ baseUrl: apiConfig.baseUrl, timeoutMs: apiConfig.timeoutMs });
}

// The mode is selected once at startup. A failed HTTP request never switches sources.
export const api: CivicFixApi = createConfiguredApi(config, authConfig);
export const API_MODE = config.mode;
export const AUTH_MODE = authConfig.mode;
export const USING_MOCK_API = API_MODE === 'mock';
