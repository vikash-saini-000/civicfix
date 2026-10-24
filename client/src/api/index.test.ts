import { describe, expect, it } from 'vitest';
import { resolveApiConfig } from './config';
import { createConfiguredApi } from './index';
import { HttpCivicFixApi } from './httpApi';

describe('API adapter selection', () => {
  it('selects exactly one configured adapter', () => {
    const mock = createConfiguredApi(resolveApiConfig({ mode: 'mock' }, false));
    const http = createConfiguredApi(resolveApiConfig({ mode: 'http', baseUrl: 'https://api.example.test' }, true));

    expect(mock).not.toBe(http);
    expect(http).toBeInstanceOf(HttpCivicFixApi);
  });
});
