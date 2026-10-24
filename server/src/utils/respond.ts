import type { Response } from 'express';

export interface SuccessBody<T, M = undefined> {
  success: true;
  data: T;
  meta?: M;
}

/** Sends `{ success: true, data, meta? }`. Use for every /api/v1 success except 204. */
export function sendSuccess<T, M>(res: Response, data: T, opts: { status?: number; meta?: M } = {}): void {
  const body: SuccessBody<T, M> = { success: true, data };
  if (opts.meta !== undefined) body.meta = opts.meta;
  res.status(opts.status ?? 200).json(body);
}

export const sendCreated = <T>(res: Response, data: T, location?: string) => {
  if (location) res.location(location);
  sendSuccess(res, data, { status: 201 });
};

export const sendNoContent = (res: Response) => {
  res.status(204).end();
};
