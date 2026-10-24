// Shapes returned by the implemented backend (docs/api/*.md). Clients must ignore unknown fields.
import type { CategoryId, ComplaintPriority, ComplaintStatus } from '../lib/domain';

export interface Page<T> {
  items: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number; hasNextPage: boolean };
}

export interface DepartmentRef {
  id: string;
  name: string;
}

export interface Department extends DepartmentRef {
  description: string | null;
  categories: CategoryId[];
  isActive: boolean;
}

export interface DepartmentMember {
  id: string;
  user: { id: string; name: string; email: string };
  role: 'MEMBER' | 'MANAGER';
  status: 'ACTIVE' | 'INACTIVE';
}

export const WORK_ORDER_STATUSES = [
  'PENDING_ASSIGNMENT',
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'BLOCKED',
  'RESOLUTION_SUBMITTED',
  'VERIFICATION_REQUIRED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number] | (string & {});

export interface WorkOrderHistoryEntry {
  at: string;
  action: string;
  actorType: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
}

export interface WorkOrder {
  id: string;
  publicId: string;
  complaint: { publicId: string; title: string; status: ComplaintStatus; landmark: string | null; address?: string | null; location: { lat: number; lng: number } | null } | null;
  department: DepartmentRef | null;
  priority: ComplaintPriority | null;
  status: WorkOrderStatus;
  assignee: { id: string; name: string } | null;
  assignmentSource: string | null;
  assignmentReason: string | null;
  assignedAt: string | null;
  dueAt: string | null;
  overdue: boolean;
  reviewRequired: string[];
  blocked: { reason: string; nextAction: string; since: string | null } | null;
  notes: { author: { id: string; name: string } | null; text: string; at: string }[];
  history: WorkOrderHistoryEntry[];
  completionNotes: string | null;
  resolutionSubmittedAt: string | null;
  verificationDecision: { decision: string; reason: string | null; source?: string; at?: string } | null;
  cancelled: { reason: string; at?: string } | null;
  completedAt: string | null;
  allowedActions: string[];
  createdAt: string;
  updatedAt: string;
}

export type WorkOrderScope = 'mine' | 'department' | 'all';

export interface WorkOrderQuery {
  scope: WorkOrderScope;
  departmentId?: string;
  status?: string[];
  overdue?: boolean;
}

/** Actions taking `{}` or a small JSON body, posted to /work-orders/:id/<action>. */
export type WorkOrderAction =
  | { action: 'accept' }
  | { action: 'start' }
  | { action: 'decline'; reason: string }
  | { action: 'block'; reason: string; nextAction: string }
  | { action: 'notes'; text: string }
  | { action: 'assign'; assigneeId: string; reason?: string }
  | { action: 'cancel'; reason: string }
  | { action: 'transfer'; departmentId: string; reason: string };

export interface ResolutionAssessment {
  outcome: string;
  reasons: string[];
  missingEvidence: string[];
}

export type VerificationDecision = 'APPROVE' | 'REJECT' | 'REQUEST_EVIDENCE';

export type EvidencePurpose = 'COMPLAINT_REPORT' | 'ADDITIONAL' | 'WORK_PROGRESS' | 'RESOLUTION' | 'DISPUTE';

/** A map point in words (GET /api/v1/geo/reverse). */
export interface LocationDescription {
  address: string | null;
  ward: { code: string; name: string } | null;
  nearestPlace: { name: string; kind: string; distanceMeters: number } | null;
  source: 'openstreetmap' | 'none';
}

/** Server rules for photos/videos (EVIDENCE_CAPTURE, MAX_VIDEO_SECONDS). */
export interface CapturePolicy {
  /** camera = files must be taken with the in-app camera; any = gallery files allowed too. */
  captureMode: 'camera' | 'any';
  maxVideoSeconds: number;
  /** Whether the server issues camera-session tokens. */
  cameraSessions: boolean;
}

export interface CaptureSession {
  token: string;
  expiresAt: string;
  captureMode: 'camera' | 'any';
  maxVideoSeconds: number;
}

export interface Evidence {
  id: string;
  purpose: EvidencePurpose | (string & {});
  mediaType: 'IMAGE' | 'VIDEO' | (string & {});
  contentType: string;
  sizeBytes: number;
  caption: string | null;
  uploadedBy: { id?: string; isReporter: boolean } | null;
  workOrderId: string | null;
  createdAt: string;
  /** Staff and admins only. */
  authenticity?: string;
  /** IN_APP_CAMERA = taken with the app's camera (time/GPS stamped); FILE_UPLOAD = chosen from files. */
  captureMethod?: 'IN_APP_CAMERA' | 'FILE_UPLOAD' | (string & {});
  durationSec?: number | null;
}

export interface ReviewQueueItem {
  publicId: string;
  title: string;
  status: ComplaintStatus;
  category: CategoryId | null;
  priority: ComplaintPriority | null;
  department: DepartmentRef | null;
  reviewReasons: string[];
  suggestedDepartment: DepartmentRef | null;
  awaitingCitizen: boolean;
  spamScore: number;
  linkedReportCount: number;
  evaluatedAt: string | null;
  createdAt: string;
}

export interface AssignComplaintInput {
  departmentId: string;
  priority: string;
  category?: string;
  assigneeId?: string;
  reason: string;
}

export interface ClassifyComplaintInput {
  departmentId: string;
  category: string;
  priority?: string;
  note?: string;
}

export interface AnalysisJob {
  status: string;
  errorCode?: string | null;
  completedAt?: string | null;
}

export interface ComplaintAnalysis {
  aiEnabled: boolean;
  classification: AnalysisJob & {
    method?: { provider: string; model: string } | null;
    suggestion?: { category: CategoryId | null; department: DepartmentRef | null; priority: ComplaintPriority | null } | null;
    summary?: string | null;
    rationale?: string | null;
    certainty?: string | null;
    missingInformation?: string[];
    reviewRecommended?: boolean;
    reviewReasons?: string[];
    mode?: string | null;
    agent?: {
      turns: number;
      toolCalls: { tool: string; ok: boolean; ms: number }[];
      proposedAssignee: { id: string; name: string } | null;
      likelyDuplicate: { publicId: string | null } | null;
    } | null;
  };
  duplicates: AnalysisJob & {
    candidates?: { publicId: string; title: string; status: string; distanceMeters: number; similarity: number; reason: string }[];
    hiddenCandidates?: number;
  };
  media: {
    evidenceId: string;
    purpose: string;
    mediaType: string;
    outcome: string;
    comparison?: { status: string; sameLocation?: string; issueAppearsFixed?: string; matchesCategory?: string; notes?: string | null } | null;
  }[];
}

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  complaintPublicId: string | null;
  workOrderPublicId: string | null;
  disputeId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface DisputeInput {
  reason: string;
  category?: 'NOT_FIXED' | 'POOR_QUALITY' | 'WRONG_LOCATION' | 'OTHER';
}

export interface FeedbackInput {
  rating: number;
  comment?: string;
}

/** Real platform metrics from GET /dashboard/admin (docs/api/DASHBOARDS.md). */
export interface AdminDashboard {
  range: { from: string; to: string };
  complaints: { byStatus: Record<string, number>; byCategory: Record<string, number>; createdInRange: number; awaitingRouting: number };
  workOrders: { byStatus: Record<string, number>; open: number; overdue: number; pendingVerification: number; bySource: Record<string, number> };
  departments: { id: string; name: string; isActive: boolean; openWorkOrders: number; overdue: number }[];
  disputes: { open: number };
  resolution: { resolvedInRange: number; averageHoursToResolve: number | null };
  ai: { classificationsInRange: Record<string, number>; autoAssignedInRange: number };
}

export interface ManagerDashboard {
  department: DepartmentRef & { isActive: boolean };
  complaints: { byStatus: Record<string, number>; byCategory: Record<string, number>; createdInRange: number; awaitingRouting: number };
  workOrders: { byStatus: Record<string, number>; open: number; unassigned: number; awaitingAcceptance: number; blocked: number; overdue: number; pendingVerification: number };
  workload: { member: { id: string; name: string }; role: string; openWorkOrders: number; overdue: number }[];
  openDisputes: number;
  resolution: { resolvedInRange: number; averageHoursToResolve: number | null };
}

/** Workflows backed by implemented server endpoints. The mock adapter does not provide them. */
export interface OperationsApi {
  // Citizen follow-through
  answerFollowUp(publicId: string, answers: string[], signal?: AbortSignal): Promise<void>;
  closeComplaint(publicId: string, signal?: AbortSignal): Promise<void>;
  disputeComplaint(publicId: string, input: DisputeInput, signal?: AbortSignal): Promise<void>;
  sendFeedback(publicId: string, input: FeedbackInput, signal?: AbortSignal): Promise<void>;

  // Evidence
  listEvidence(publicId: string, signal?: AbortSignal): Promise<Evidence[]>;
  uploadEvidence(publicId: string, file: File, purpose: EvidencePurpose, caption?: string, signal?: AbortSignal): Promise<Evidence>;
  fetchEvidenceContent(evidenceId: string, signal?: AbortSignal): Promise<Blob>;
  getCapturePolicy(signal?: AbortSignal): Promise<CapturePolicy>;
  /** Street address, ward and nearest mapped place for a point. */
  describeLocation(lat: number, lng: number, signal?: AbortSignal): Promise<LocationDescription>;
  /** Opens an in-app camera session; captured files are uploaded with its token. */
  startCaptureSession(signal?: AbortSignal): Promise<CaptureSession>;

  // Triage and routing
  getAnalysis(publicId: string, signal?: AbortSignal): Promise<ComplaintAnalysis>;
  /** Platform admins: queue the AI triage (and duplicate check) again. */
  rerunAnalysis(publicId: string, types?: ('TRIAGE' | 'DUPLICATE_CANDIDATES')[], signal?: AbortSignal): Promise<void>;
  listReviewQueue(signal?: AbortSignal): Promise<ReviewQueueItem[]>;
  assignComplaint(publicId: string, input: AssignComplaintInput, signal?: AbortSignal): Promise<WorkOrder>;
  classifyComplaint(publicId: string, input: ClassifyComplaintInput, signal?: AbortSignal): Promise<void>;
  rejectComplaint(publicId: string, reason: string, signal?: AbortSignal): Promise<void>;
  listDepartments(signal?: AbortSignal): Promise<Department[]>;
  listDepartmentMembers(departmentId: string, signal?: AbortSignal): Promise<DepartmentMember[]>;

  // Work orders
  listWorkOrders(query: WorkOrderQuery, signal?: AbortSignal): Promise<WorkOrder[]>;
  getWorkOrder(id: string, signal?: AbortSignal): Promise<WorkOrder | null>;
  workOrderAction(id: string, action: WorkOrderAction, signal?: AbortSignal): Promise<WorkOrder>;
  submitResolution(id: string, completionNotes: string, evidenceIds: string[], signal?: AbortSignal): Promise<{ workOrder: WorkOrder; assessment: ResolutionAssessment | null }>;
  verifyResolution(id: string, decision: VerificationDecision, reason: string, signal?: AbortSignal): Promise<WorkOrder>;

  // Notifications
  listNotifications(signal?: AbortSignal): Promise<AppNotification[]>;
  unreadNotificationCount(signal?: AbortSignal): Promise<number>;
  markNotificationRead(id: string, signal?: AbortSignal): Promise<void>;
  markAllNotificationsRead(signal?: AbortSignal): Promise<void>;

  // Dashboards
  getAdminDashboard(signal?: AbortSignal): Promise<AdminDashboard>;
  getManagerDashboard(departmentId: string, signal?: AbortSignal): Promise<ManagerDashboard>;
}
