import type { Types } from 'mongoose';
import type { Principal } from '../auth/roles.js';
import type { ResourceType } from '../models/enums.js';
import { AuditLog } from '../models/index.js';
import { safeError } from '../config/database.js';
import type { Logger } from '../utils/logger.js';

let auditLogger: Logger | null = null;
/** Where audit-write failures are reported. Set once by createApp. */
export function setAuditLogger(logger: Logger) {
  auditLogger = logger;
}

export interface AuditChange {
  field: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Records a successful action by an authenticated user. Values in `changes` must be non-sensitive.
 * Written after the business change is stored. If the audit write itself fails, the failure is
 * logged at error level with the action and target, and the request still succeeds: the change
 * already happened and must not be reported to the user as failed.
 */
export async function auditUserAction(opts: {
  actor: Principal;
  action: string;
  targetType: ResourceType;
  targetId: Types.ObjectId | string;
  requestId: string;
  changes?: AuditChange[];
  reason?: string;
}): Promise<void> {
  try {
    await AuditLog.create({
      actorType: 'USER',
      actor: opts.actor.userId,
      action: opts.action,
      targetType: opts.targetType,
      targetId: opts.targetId,
      outcome: 'SUCCESS',
      reason: opts.reason,
      correlationId: opts.requestId || undefined,
      changes: opts.changes ?? [],
    });
  } catch (err) {
    auditLogger?.error({ err: safeError(err), action: opts.action, targetType: opts.targetType, targetId: String(opts.targetId) }, 'audit write failed');
  }
}

/** Field-level diff of plain values (arrays compared by content). */
export function diff<T extends Record<string, unknown>>(before: T, after: T, fields: (keyof T & string)[]): AuditChange[] {
  return fields
    .filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]))
    .map((f) => ({ field: f, before: before[f], after: after[f] }));
}
