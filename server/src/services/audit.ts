import type { Types } from 'mongoose';
import type { Principal } from '../auth/roles.js';
import type { ResourceType } from '../models/enums.js';
import { AuditLog } from '../models/index.js';

export interface AuditChange {
  field: string;
  before?: unknown;
  after?: unknown;
}

/** Records a successful action by an authenticated user. Values in `changes` must be non-sensitive. */
export async function auditUserAction(opts: {
  actor: Principal;
  action: string;
  targetType: ResourceType;
  targetId: Types.ObjectId | string;
  requestId: string;
  changes?: AuditChange[];
  reason?: string;
}): Promise<void> {
  await AuditLog.create({
    actorType: 'USER',
    actor: opts.actor.userId,
    action: opts.action,
    targetType: opts.targetType,
    targetId: opts.targetId,
    outcome: 'SUCCESS',
    reason: opts.reason,
    correlationId: opts.requestId,
    changes: opts.changes ?? [],
  });
}

/** Field-level diff of plain values (arrays compared by content). */
export function diff<T extends Record<string, unknown>>(before: T, after: T, fields: (keyof T & string)[]): AuditChange[] {
  return fields
    .filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]))
    .map((f) => ({ field: f, before: before[f], after: after[f] }));
}
