import { describe, expect, it } from 'vitest';
import { ApiConfigError } from './errors';
import { resolveApiConfig, resolveAuthConfig } from './config';

describe('API configuration', () => {
  it('defaults development to mock mode and production to HTTP mode', () => {
    expect(resolveApiConfig({}, true)).toMatchObject({ mode: 'mock', baseUrl: '' });
    expect(resolveApiConfig({}, false)).toMatchObject({ mode: 'http', baseUrl: '' });
  });

  it('accepts explicit mode and trims the base URL', () => {
    expect(
      resolveApiConfig(
        { mode: 'http', baseUrl: 'https://api.example.test/', timeoutMs: '2500' },
        true,
      ),
    ).toEqual({ mode: 'http', baseUrl: 'https://api.example.test', timeoutMs: 2500 });
  });

  it('rejects invalid configuration instead of silently selecting another adapter', () => {
    expect(() => resolveApiConfig({ mode: 'remote' }, true)).toThrow(ApiConfigError);
    expect(() => resolveApiConfig({ timeoutMs: '0' }, true)).toThrow(ApiConfigError);
  });

  it('keeps authentication mode aligned with API mode and blocks mock auth in production', () => {
    expect(resolveAuthConfig({}, true, 'mock')).toEqual({ mode: 'mock' });
    expect(resolveAuthConfig({ mode: 'http' }, false, 'http')).toEqual({ mode: 'http' });
    expect(() => resolveAuthConfig({ mode: 'mock' }, false, 'mock')).toThrow(ApiConfigError);
    expect(() => resolveAuthConfig({ mode: 'http' }, true, 'mock')).toThrow(ApiConfigError);
  });
});
