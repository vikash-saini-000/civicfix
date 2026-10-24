// In-process domain events. Emitted only after a business operation has succeeded and been stored.
// Handlers (e.g. notifications) run in-process; a handler failure is logged and never undoes or fails
// the business operation. Not durable: a crash between the write and the handler loses that event's
// side effects (see docs/api/NOTIFICATIONS.md for the trade-off and the outbox next step).
import { safeError } from '../config/database.js';
import type { Logger } from '../utils/logger.js';

export interface DomainEvents {
  'complaint.created': { complaintId: string };
  'complaint.status_changed': { complaintId: string; from: string; to: string; note?: string };
  'assignment.review_required': { complaintId: string; departmentId: string | null; reasons: string[] };
  'work_order.created': { workOrderId: string; complaintId: string; departmentId: string; source: string };
  'work_order.assigned': { workOrderId: string; assigneeId: string };
  'work_order.status_changed': { workOrderId: string; from: string; to: string; actorId: string | null };
  'resolution.submitted': { workOrderId: string; complaintId: string };
  'resolution.decided': { workOrderId: string; complaintId: string; decision: string };
  'dispute.created': { disputeId: string; complaintId: string };
  'dispute.decided': { disputeId: string; complaintId: string; decision: string };
}

export type EventName = keyof DomainEvents;
type Handler<E extends EventName> = (payload: DomainEvents[E], meta: { eventId: string }) => Promise<void> | void;

export function createEventBus(logger: Logger) {
  const handlers = new Map<EventName, Handler<EventName>[]>();
  let seq = 0;

  return {
    on<E extends EventName>(event: E, handler: Handler<E>) {
      const list = handlers.get(event) ?? [];
      list.push(handler as Handler<EventName>);
      handlers.set(event, list);
    },
    /**
     * Runs handlers one by one and waits for them, so tests and callers see their effects, but never
     * throws. `eventKey` should identify the business fact (e.g. "<workOrderId>:accepted:<n>") so that
     * handlers can deduplicate retries.
     */
    async emit<E extends EventName>(event: E, payload: DomainEvents[E], eventKey?: string): Promise<void> {
      const eventId = eventKey ?? `${event}:${Date.now()}:${++seq}`;
      for (const handler of handlers.get(event) ?? []) {
        try {
          await handler(payload, { eventId });
        } catch (err) {
          logger.error({ err: safeError(err), event }, 'event handler failed');
        }
      }
    },
  };
}
export type EventBus = ReturnType<typeof createEventBus>;
