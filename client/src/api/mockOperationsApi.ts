import { ApiError } from './errors';
import type { OperationsApi } from './operationsTypes';

/**
 * The mock adapter only covers the original citizen/department screens. Workflows that exist only in
 * the real backend (work orders, review queue, evidence, notifications, dashboards) fail clearly.
 */
export function createMockOperationsApi(): OperationsApi {
  const unsupported = () => Promise.reject(new ApiError('This workflow needs the CivicFix backend. Set VITE_CIVICFIX_API_MODE=http.', 501, 'BACKEND_REQUIRED'));
  return {
    answerFollowUp: unsupported,
    closeComplaint: unsupported,
    disputeComplaint: unsupported,
    sendFeedback: unsupported,
    listEvidence: () => Promise.resolve([]),
    uploadEvidence: unsupported,
    fetchEvidenceContent: unsupported,
    describeLocation: () => Promise.resolve({ address: null, ward: null, nearestPlace: null, source: 'none' as const }),
    getCapturePolicy: () => Promise.resolve({ captureMode: 'any' as const, maxVideoSeconds: 60, cameraSessions: false }),
    startCaptureSession: () => Promise.resolve({ token: 'mock-camera-session', expiresAt: new Date(Date.now() + 1_800_000).toISOString(), captureMode: 'any' as const, maxVideoSeconds: 60 }),
    getAnalysis: unsupported,
    rerunAnalysis: unsupported,
    listReviewQueue: unsupported,
    assignComplaint: unsupported,
    classifyComplaint: unsupported,
    rejectComplaint: unsupported,
    listDepartments: unsupported,
    listDepartmentMembers: unsupported,
    listWorkOrders: unsupported,
    getWorkOrder: unsupported,
    workOrderAction: unsupported,
    submitResolution: unsupported,
    verifyResolution: unsupported,
    listNotifications: unsupported,
    unreadNotificationCount: () => Promise.resolve(0),
    markNotificationRead: unsupported,
    markAllNotificationsRead: unsupported,
    getAdminDashboard: unsupported,
    getManagerDashboard: unsupported,
  };
}
