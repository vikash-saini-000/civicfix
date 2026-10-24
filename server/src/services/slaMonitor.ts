// SLA timers: finds open work orders that passed their target time (dueAt) and records the breach once,
// with an audit entry and an alert to the assignee and the department's managers. Runs on an interval in
// the server process; safe to run in several places at once (each breach is claimed atomically).
import type { EventBus } from '../events/bus.js';
import { AuditLog, WorkOrder } from '../models/index.js';
import { OPEN_WORK_ORDER_STATUSES } from '../policies/workOrderLifecycle.js';
import { safeError } from '../config/database.js';
import type { Logger } from '../utils/logger.js';

export function createSlaMonitor(deps: { events: EventBus; logger: Logger; batchSize?: number }) {
  const batch = deps.batchSize ?? 100;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<number> | null = null;

  /** One pass. Returns how many new breaches were recorded. */
  async function checkOnce(now = new Date()): Promise<number> {
    const due = await WorkOrder.find({ status: { $in: OPEN_WORK_ORDER_STATUSES }, dueAt: { $lt: now }, slaBreachedAt: null })
      .sort({ dueAt: 1 })
      .limit(batch)
      .select('_id complaint department assignee dueAt publicId')
      .lean();
    let count = 0;
    for (const wo of due) {
      // Claim it: only the first pass that flips slaBreachedAt sends alerts.
      const claimed = await WorkOrder.updateOne({ _id: wo._id, slaBreachedAt: null, status: { $in: OPEN_WORK_ORDER_STATUSES } }, { $set: { slaBreachedAt: now } });
      if (claimed.modifiedCount !== 1) continue;
      count++;
      await AuditLog.create({
        actorType: 'SYSTEM',
        action: 'work_order.sla_breached',
        targetType: 'WorkOrder',
        targetId: wo._id,
        outcome: 'SUCCESS',
        reason: `target time ${wo.dueAt!.toISOString()} passed`,
      });
      await deps.events.emit(
        'work_order.overdue',
        { workOrderId: String(wo._id), complaintId: String(wo.complaint), departmentId: String(wo.department), assigneeId: wo.assignee ? String(wo.assignee) : null, dueAt: wo.dueAt!.toISOString() },
        `${wo._id}:overdue:${wo.dueAt!.getTime()}`,
      );
    }
    if (count > 0) deps.logger.info({ breaches: count }, 'SLA breaches recorded');
    return count;
  }

  return {
    checkOnce,
    start(intervalMs = 5 * 60_000) {
      const tick = () => {
        if (running) return;
        running = checkOnce()
          .catch((err) => {
            deps.logger.error({ err: safeError(err) }, 'SLA check failed');
            return 0;
          })
          .finally(() => {
            running = null;
          });
      };
      timer = setInterval(tick, intervalMs);
      timer.unref();
      tick();
    },
    async stop() {
      if (timer) clearInterval(timer);
      await running;
    },
  };
}
export type SlaMonitor = ReturnType<typeof createSlaMonitor>;
