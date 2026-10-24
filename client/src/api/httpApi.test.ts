import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors';
import { HttpCivicFixApi } from './httpApi';

describe('HttpCivicFixApi', () => {
  it('unwraps a typed JSON response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ publicId: 'CF-2026-00001' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: 'https://api.example.test', timeoutMs: 1000 });

    await expect(api.listMyComplaints()).resolves.toEqual([{ publicId: 'CF-2026-00001' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/complaints',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('turns non-success JSON responses into ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Not allowed', code: 'FORBIDDEN' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });

    await expect(api.listMyComplaints()).rejects.toMatchObject<Partial<ApiError>>({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Not allowed',
    });
  });

  it('uses credentialed auth endpoints without persisting tokens client-side', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { user: { id: 'u1', email: 'citizen@example.test', displayName: 'Citizen', role: 'citizen' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: 'u1', email: 'citizen@example.test', displayName: 'Citizen', role: 'citizen' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: 'https://api.example.test', timeoutMs: 1000 });

    await expect(api.login({ email: 'citizen@example.test', password: 'not-stored' })).resolves.toMatchObject({
      user: { id: 'u1', role: 'citizen' },
    });
    await expect(api.getCurrentUser()).resolves.toMatchObject({ id: 'u1' });
    await expect(api.logout()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.example.test/api/v1/auth/login',
      expect.objectContaining({ method: 'POST', credentials: 'include', body: JSON.stringify({ email: 'citizen@example.test', password: 'not-stored' }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://api.example.test/api/v1/auth/logout',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });
});
