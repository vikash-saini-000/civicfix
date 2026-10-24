import type { Complaint, NewComplaintInput } from '../lib/domain';
import type { DepartmentContext } from '../auth/department';
import type { AuthSession, AuthUser, LoginCredentials, RegisterInput } from './authTypes';
import { mapBackendUser, membershipDepartmentIds } from './backendUser';
import { parseComplaint, parseComplaintList, parsePlatformComplaint, parseStaffComplaint } from './complaintContract';
import { ApiError } from './errors';
import type {
  AdminDashboard,
  AppNotification,
  AssignComplaintInput,
  ClassifyComplaintInput,
  ComplaintAnalysis,
  Department,
  DepartmentMember,
  DisputeInput,
  Evidence,
  EvidencePurpose,
  FeedbackInput,
  ManagerDashboard,
  ResolutionAssessment,
  ReviewQueueItem,
  VerificationDecision,
  WorkOrder,
  WorkOrderAction,
  WorkOrderQuery,
} from './operationsTypes';
import type { CivicFixApi, PlatformComplaint, StaffComplaint } from './types';

export interface HttpApiOptions {
  baseUrl: string;
  timeoutMs: number;
  credentials?: RequestCredentials;
}

interface RequestOptions {
  method?: string;
  /** JSON body (object) or raw upload body (Blob). */
  body?: object | Blob;
  contentType?: string;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /** Send the bearer token and refresh it on 401. Default true. */
  auth?: boolean;
  /** Add the CSRF header required by /auth/refresh and /auth/logout. */
  csrf?: boolean;
  responseType?: 'json' | 'blob';
  /** Never refresh the token for this request (used while a refresh is running). */
  noRefresh?: boolean;
}

interface Envelope<T> {
  data: T;
  meta?: { pagination?: { page: number; totalPages: number; hasNextPage: boolean } };
}

const API = '/api/v1';
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 30_000;
/** Safety cap when collecting every page of a list (100 per page). */
const MAX_PAGES = 20;

/**
 * Client for the CivicFix backend (docs/api). The access token lives in memory only; the refresh
 * token is an HttpOnly cookie the browser sends to /api/v1/auth. One refresh runs at a time, and a
 * request that gets 401 is retried once after refreshing.
 */
export class HttpCivicFixApi implements CivicFixApi {
  readonly capabilities = { photoAttachments: true, operations: true } as const;

  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private refreshInFlight: Promise<AuthUser | null> | null = null;
  private departmentNames = new Map<string, string>();

  constructor(private readonly options: HttpApiOptions) {}

  // ---------------------------------------------------------------- auth

  async login(credentials: LoginCredentials, signal?: AbortSignal): Promise<AuthSession> {
    const data = await this.data<unknown>('/auth/login', { method: 'POST', body: credentials, signal, auth: false });
    return { user: await this.acceptSession(data) };
  }

  async register(input: RegisterInput, signal?: AbortSignal): Promise<AuthSession> {
    const data = await this.data<unknown>('/auth/register', { method: 'POST', body: input, signal, auth: false });
    return { user: await this.acceptSession(data) };
  }

  async getCurrentUser(signal?: AbortSignal): Promise<AuthUser | null> {
    // On app start there is no token in memory: the refresh cookie (if any) restores the session.
    if (!this.accessToken) return this.refresh();
    try {
      const data = await this.data<{ user: unknown }>('/auth/me', { signal });
      return this.mapUser(data.user);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return null;
      throw error;
    }
  }

  async logout(signal?: AbortSignal): Promise<void> {
    try {
      await this.send('/auth/logout', { method: 'POST', signal, csrf: true, auth: false, bearerOptional: true });
    } finally {
      this.clearToken();
    }
  }

  // ---------------------------------------------------------- complaints

  async listMyComplaints(signal?: AbortSignal): Promise<Complaint[]> {
    return parseComplaintList(await this.all<unknown>('/complaints', { scope: 'mine', sort: '-updatedAt' }, signal));
  }

  async getComplaint(publicId: string, signal?: AbortSignal): Promise<Complaint | null> {
    return this.orNull(async () => parseComplaint(await this.data<unknown>(`/complaints/${enc(publicId)}`, { signal })));
  }

  async submitComplaint(input: NewComplaintInput, signal?: AbortSignal): Promise<Complaint> {
    const body = {
      title: input.title,
      description: input.description,
      location: input.location,
      selectedCategory: input.selectedCategory,
      ...(input.landmark ? { landmark: input.landmark } : {}),
    };
    // Photos that look AI-generated or edited are refused before the complaint is created.
    for (const [index, photo] of input.photos.entries()) {
      const check = await this.checkMedia(photo, signal);
      if (!check.allowed) {
        const label = photo.name ? `"${photo.name}"` : `Photo ${index + 1}`;
        throw new ApiError(`${label}: ${check.message ?? 'This file was not accepted.'}`, 422, 'MEDIA_REJECTED');
      }
    }
    const created = parseComplaint(await this.data<unknown>('/complaints', { method: 'POST', body, signal }));
    // Photos are uploaded after the complaint exists. A failed upload never loses the report itself.
    let uploaded = 0;
    for (const photo of input.photos) {
      try {
        await this.uploadEvidence(created.publicId, photo, 'COMPLAINT_REPORT', undefined, signal);
        uploaded += 1;
      } catch {
        // Reported to the user through photoCount below.
      }
    }
    return { ...created, photoCount: uploaded, ...(uploaded < input.photos.length ? { photoUploadFailures: input.photos.length - uploaded } : {}) };
  }

  async answerFollowUp(publicId: string, answers: string[], signal?: AbortSignal): Promise<void> {
    await this.data(`/complaints/${enc(publicId)}/follow-up`, { method: 'POST', body: { answers }, signal });
  }

  async closeComplaint(publicId: string, signal?: AbortSignal): Promise<void> {
    await this.data(`/complaints/${enc(publicId)}/close`, { method: 'POST', body: {}, signal });
  }

  async disputeComplaint(publicId: string, input: DisputeInput, signal?: AbortSignal): Promise<void> {
    await this.data(`/complaints/${enc(publicId)}/disputes`, { method: 'POST', body: input, signal });
  }

  async sendFeedback(publicId: string, input: FeedbackInput, signal?: AbortSignal): Promise<void> {
    await this.data(`/complaints/${enc(publicId)}/feedback`, { method: 'POST', body: input, signal });
  }

  // ------------------------------------------------- department and admin

  async listDepartmentComplaints(context: DepartmentContext, signal?: AbortSignal): Promise<StaffComplaint[]> {
    const items = await this.all<unknown>('/complaints', { scope: 'department', departmentId: context.departmentId, sort: '-updatedAt' }, signal);
    return items.map(parseStaffComplaint);
  }

  async getDepartmentComplaint(_context: DepartmentContext, publicId: string, signal?: AbortSignal): Promise<StaffComplaint | null> {
    return this.orNull(async () => parseStaffComplaint(await this.data<unknown>(`/complaints/${enc(publicId)}`, { signal })));
  }

  async listPlatformComplaints(signal?: AbortSignal): Promise<PlatformComplaint[]> {
    const items = await this.all<unknown>('/complaints', { scope: 'all', sort: '-createdAt' }, signal);
    return items.map(parsePlatformComplaint);
  }

  async getAnalysis(publicId: string, signal?: AbortSignal): Promise<ComplaintAnalysis> {
    return (await this.data<{ analysis: ComplaintAnalysis }>(`/complaints/${enc(publicId)}/analysis`, { signal })).analysis;
  }

  async rerunAnalysis(publicId: string, types: ('TRIAGE' | 'DUPLICATE_CANDIDATES')[] = ['TRIAGE', 'DUPLICATE_CANDIDATES'], signal?: AbortSignal): Promise<void> {
    await this.data(`/complaints/${enc(publicId)}/analysis`, { method: 'POST', body: { types }, signal });
  }

  async listReviewQueue(signal?: AbortSignal): Promise<ReviewQueueItem[]> {
    return this.all<ReviewQueueItem>('/assignments/queue', {}, signal);
  }

  async assignComplaint(publicId: string, input: AssignComplaintInput, signal?: AbortSignal): Promise<WorkOrder> {
    return (await this.data<{ workOrder: WorkOrder }>(`/complaints/${enc(publicId)}/assign`, { method: 'POST', body: compact(input), signal })).workOrder;
  }

  async classifyComplaint(publicId: string, input: ClassifyComplaintInput, signal?: AbortSignal): Promise<void> {
    await this.data(`/complaints/${enc(publicId)}/classify`, { method: 'POST', body: compact(input), signal });
  }

  async rejectComplaint(publicId: string, reason: string, signal?: AbortSignal): Promise<void> {
    await this.data(`/complaints/${enc(publicId)}/reject`, { method: 'POST', body: { reason }, signal });
  }

  async listDepartments(signal?: AbortSignal): Promise<Department[]> {
    const items = await this.all<Department>('/departments', {}, signal);
    for (const d of items) this.departmentNames.set(d.id, d.name);
    return items;
  }

  async listDepartmentMembers(departmentId: string, signal?: AbortSignal): Promise<DepartmentMember[]> {
    return this.all<DepartmentMember>(`/departments/${enc(departmentId)}/members`, {}, signal);
  }

  // ------------------------------------------------------------ evidence

  async listEvidence(publicId: string, signal?: AbortSignal): Promise<Evidence[]> {
    const data = await this.data<unknown>(`/complaints/${enc(publicId)}/evidence`, { signal });
    // The list endpoint returns the array directly; tolerate { evidence: [...] } too.
    if (Array.isArray(data)) return data as Evidence[];
    if (isRecord(data) && Array.isArray(data.evidence)) return data.evidence as Evidence[];
    throw new ApiError('The evidence service returned an invalid response.', 502, 'INVALID_RESPONSE');
  }

  /** Asks the backend whether a photo/video would be accepted (AI-generated or edited files are not). Stores nothing. */
  async checkMedia(file: File, signal?: AbortSignal): Promise<{ allowed: boolean; message: string | null }> {
    const data = await this.data<{ allowed?: unknown; message?: unknown }>('/evidence/check', {
      method: 'POST',
      body: file,
      contentType: file.type || 'application/octet-stream',
      signal,
    });
    return { allowed: data?.allowed !== false, message: typeof data?.message === 'string' ? data.message : null };
  }

  async uploadEvidence(publicId: string, file: File, purpose: EvidencePurpose, caption?: string, signal?: AbortSignal): Promise<Evidence> {
    const data = await this.data<{ evidence: Evidence }>(`/complaints/${enc(publicId)}/evidence`, {
      method: 'POST',
      body: file,
      contentType: file.type || 'application/octet-stream',
      query: { purpose, caption: caption || undefined },
      signal,
    });
    return data.evidence;
  }

  async fetchEvidenceContent(evidenceId: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.send(`/evidence/${enc(evidenceId)}/content`, { signal, responseType: 'blob' });
    return response as Blob;
  }

  // --------------------------------------------------------- work orders

  async listWorkOrders(query: WorkOrderQuery, signal?: AbortSignal): Promise<WorkOrder[]> {
    return this.all<WorkOrder>('/work-orders', {
      scope: query.scope,
      departmentId: query.departmentId,
      status: query.status?.length ? query.status.join(',') : undefined,
      overdue: query.overdue ? 'true' : undefined,
    }, signal);
  }

  async getWorkOrder(id: string, signal?: AbortSignal): Promise<WorkOrder | null> {
    return this.orNull(async () => (await this.data<{ workOrder: WorkOrder }>(`/work-orders/${enc(id)}`, { signal })).workOrder);
  }

  async workOrderAction(id: string, input: WorkOrderAction, signal?: AbortSignal): Promise<WorkOrder> {
    const { action, ...body } = input;
    return (await this.data<{ workOrder: WorkOrder }>(`/work-orders/${enc(id)}/${action}`, { method: 'POST', body: compact(body), signal })).workOrder;
  }

  async submitResolution(id: string, completionNotes: string, evidenceIds: string[], signal?: AbortSignal) {
    const data = await this.data<{ workOrder: WorkOrder; assessment?: ResolutionAssessment }>(`/work-orders/${enc(id)}/resolution`, {
      method: 'POST',
      body: { completionNotes, evidenceIds },
      signal,
    });
    return { workOrder: data.workOrder, assessment: data.assessment ?? null };
  }

  async verifyResolution(id: string, decision: VerificationDecision, reason: string, signal?: AbortSignal): Promise<WorkOrder> {
    return (await this.data<{ workOrder: WorkOrder }>(`/work-orders/${enc(id)}/verification`, { method: 'POST', body: { decision, reason }, signal })).workOrder;
  }

  // ------------------------------------------------------- notifications

  async listNotifications(signal?: AbortSignal): Promise<AppNotification[]> {
    const envelope = await this.envelope<AppNotification[]>('/notifications', { query: { page: 1, limit: 50 }, signal });
    return envelope.data;
  }

  async unreadNotificationCount(signal?: AbortSignal): Promise<number> {
    return (await this.data<{ count: number }>('/notifications/unread-count', { signal })).count;
  }

  async markNotificationRead(id: string, signal?: AbortSignal): Promise<void> {
    await this.data(`/notifications/${enc(id)}/read`, { method: 'POST', body: {}, signal });
  }

  async markAllNotificationsRead(signal?: AbortSignal): Promise<void> {
    await this.data('/notifications/read-all', { method: 'POST', body: {}, signal });
  }

  // ---------------------------------------------------------- dashboards

  async getAdminDashboard(signal?: AbortSignal): Promise<AdminDashboard> {
    return this.data<AdminDashboard>('/dashboard/admin', { query: { period: '30d' }, signal });
  }

  async getManagerDashboard(departmentId: string, signal?: AbortSignal): Promise<ManagerDashboard> {
    return this.data<ManagerDashboard>('/dashboard/department/manager', { query: { departmentId, period: '30d' }, signal });
  }

  // ------------------------------------------------------------ internals

  private async acceptSession(data: unknown): Promise<AuthUser> {
    if (!isRecord(data) || typeof data.accessToken !== 'string') {
      throw new ApiError('The sign-in service returned an invalid session.', 502, 'INVALID_RESPONSE');
    }
    this.accessToken = data.accessToken;
    const expiresIn = typeof data.expiresIn === 'number' ? data.expiresIn : 900;
    this.accessTokenExpiresAt = Date.now() + expiresIn * 1000;
    return this.mapUser(data.user);
  }

  /** Maps the backend user, loading department names for its memberships once. */
  private async mapUser(raw: unknown): Promise<AuthUser> {
    const ids = membershipDepartmentIds(raw);
    if (ids.some((id) => !this.departmentNames.has(id))) {
      try {
        const departments = await this.all<Department>('/departments', {}, undefined, { noRefresh: true });
        for (const d of departments) this.departmentNames.set(d.id, d.name);
      } catch {
        // Names are cosmetic; the department ID is still shown.
      }
    }
    return mapBackendUser(raw, this.departmentNames);
  }

  private clearToken() {
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  /**
   * Exchanges the refresh cookie for a new access token. Only one refresh runs at a time (and one
   * per browser when Web Locks exist): two parallel refreshes look like token reuse and end the session.
   */
  private refresh(): Promise<AuthUser | null> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const run = async (): Promise<AuthUser | null> => {
      try {
        const data = await this.data<unknown>('/auth/refresh', { method: 'POST', csrf: true, auth: false });
        return await this.acceptSession(data);
      } catch (error) {
        this.clearToken();
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return null;
        throw error;
      }
    };
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    const locked: Promise<AuthUser | null> = locks ? locks.request('civicfix-auth-refresh', () => run()).then((user) => user) : run();
    const promise = locked.finally(() => {
      this.refreshInFlight = null;
    });
    this.refreshInFlight = promise;
    return promise;
  }

  private async data<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return (await this.envelope<T>(path, options)).data;
  }

  private async envelope<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
    const payload = await this.send(path, options);
    if (isRecord(payload) && 'data' in payload) return payload as unknown as Envelope<T>;
    return { data: payload as T };
  }

  /** Collects every page of a paginated list (100 per page, capped). */
  private async all<T>(path: string, query: Record<string, string | undefined>, signal?: AbortSignal, extra: Partial<RequestOptions> = {}): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const envelope = await this.envelope<T[]>(path, { ...extra, query: { ...query, page, limit: 100 }, signal });
      if (!Array.isArray(envelope.data)) throw new ApiError('The service returned an invalid list.', 502, 'INVALID_RESPONSE');
      items.push(...envelope.data);
      if (!envelope.meta?.pagination?.hasNextPage) break;
    }
    return items;
  }

  private async orNull<T>(load: () => Promise<T>): Promise<T | null> {
    try {
      return await load();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async send(path: string, options: RequestOptions & { bearerOptional?: boolean } = {}, retried = false): Promise<unknown> {
    const useAuth = options.auth ?? true;
    if (useAuth && !options.noRefresh && this.accessToken && Date.now() > this.accessTokenExpiresAt - REFRESH_MARGIN_MS) {
      await this.refresh();
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), this.options.timeoutMs);
    const signal = mergeSignals(options.signal, controller.signal);
    const headers = new Headers({ Accept: 'application/json' });
    if ((useAuth || options.bearerOptional) && this.accessToken) headers.set('Authorization', `Bearer ${this.accessToken}`);
    if (options.csrf) headers.set('X-Requested-With', 'civicfix');

    let body: BodyInit | undefined;
    if (options.body instanceof Blob) {
      body = options.body;
      headers.set('Content-Type', options.contentType ?? options.body.type);
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers.set('Content-Type', 'application/json');
    }

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${API}${path}${queryString(options.query)}`, {
        method: options.method ?? 'GET',
        headers,
        body,
        signal,
        credentials: this.options.credentials ?? 'include',
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError('The request timed out or was cancelled.', 408, 'REQUEST_ABORTED');
      }
      throw new ApiError('The service could not be reached.', 0, 'NETWORK_ERROR');
    } finally {
      window.clearTimeout(timeout);
    }

    if (response.ok && options.responseType === 'blob') return response.blob();
    const payload = await readResponse(response);
    if (response.ok) return payload;

    const error = toApiError(response.status, payload);
    // Expired or revoked access token: refresh once and retry.
    if (useAuth && !options.noRefresh && !retried && error.status === 401 && error.code === 'UNAUTHENTICATED') {
      const user = await this.refresh().catch(() => null);
      if (user) return this.send(path, options, true);
    }
    throw error;
  }
}

function toApiError(status: number, payload: unknown): ApiError {
  // Backend envelope: { success: false, error: { code, message, details }, requestId }
  const inner = isRecord(payload) && isRecord(payload.error) ? payload.error : isRecord(payload) ? payload : {};
  return new ApiError(
    typeof inner.message === 'string' ? inner.message : 'The request was not accepted.',
    status,
    typeof inner.code === 'string' ? inner.code : undefined,
    inner.details,
  );
}

async function readResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return undefined;
  try {
    return await response.json();
  } catch {
    throw new ApiError('The service returned an invalid response.', response.status, 'INVALID_RESPONSE');
  }
}

function queryString(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** Drops undefined and empty-string fields: the backend rejects unknown or empty values. */
function compact<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function mergeSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  if (!first) return second;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second.aborted) abort();
  first.addEventListener('abort', abort, { once: true });
  second.addEventListener('abort', abort, { once: true });
  return controller.signal;
}
