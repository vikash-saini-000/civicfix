import { UnsupportedWorkflowPage } from './UnsupportedWorkflowPage';

export function NotificationsPage() {
  return (
    <UnsupportedWorkflowPage
      title="Notifications"
      intro="Notification delivery and read state require an implemented backend contract."
      capability="Notifications"
      explanation="This repository has no notification endpoint, unread-count response, pagination contract, or read/mark-all mutation. No fake notifications or unread counts are displayed."
      guardrailMessage="Existing authorized complaint activity remains available on complaint detail pages. Persistent notifications will appear here after the backend contract is implemented."
      backTo="/"
      backLabel="Return home"
    />
  );
}
