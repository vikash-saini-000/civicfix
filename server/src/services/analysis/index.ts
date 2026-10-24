import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import type { AiProvider } from '../../ai/types.js';
import type { Principal } from '../../auth/roles.js';
import { AIAnalysis, Complaint, Department, Evidence, User } from '../../models/index.js';
import { AppError, notFoundError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { relationTo, type ComplaintService } from '../complaints.js';
import { analyzeMedia, mediaRecordFields, type AuthenticityResult } from './mediaAuthenticity.js';
import { createAnalysisRunner, JOB_TYPES, type JobType, type RunnerOptions } from './runner.js';

export { JOB_TYPES, type JobType };

const isActiveStatus = (s: string) => s === 'PENDING' || s === 'RUNNING';

type AnalysisDoc = Record<string, any> & { _id: Types.ObjectId; status: string; analysisVersion: number; createdAt?: Date };

function jobView(a: AnalysisDoc) {
  return {
    status: a.status,
    version: a.analysisVersion,
    requestedAt: a.createdAt?.toISOString() ?? null,
    completedAt: a.completedAt?.toISOString() ?? null,
    attempts: a.attempts ?? 0,
    errorCode: a.errorCode ?? null,
    method: a.provider ? { provider: a.provider, model: a.modelName ?? null } : null,
  };
}

export interface AnalysisServiceOptions extends Omit<RunnerOptions, 'logger'> {
  logger: Logger;
  /** strict = also refuse "some signs"; block (default) = refuse uploads flagged as AI-generated or edited; flag = store and mark for review. */
  mediaUploadGate?: 'strict' | 'block' | 'flag';
}

/** Authenticity outcomes that stop an upload when the gate is `block`. */
export const BLOCKED_MEDIA_OUTCOMES = new Set(['POTENTIAL_SYNTHETIC_MEDIA', 'POTENTIAL_MANIPULATION']);
/** Results that won't change on retry; transient AI failures are not cached so a retry can run the check. */
const STABLE_ERRORS = new Set([undefined, 'VIDEO_TOOLS_UNAVAILABLE', 'TOO_LARGE_FOR_VISUAL_MODEL', 'NOT_CONFIGURED']);
const SCREEN_CACHE_MS = 30 * 60_000;
const SCREEN_CACHE_MAX = 500;

/** Signals that count as "some signs" for the strict gate. */
const STRICT_FINDINGS = new Set(['visual_inconsistency_some', 'visual_inconsistency_strong', 'editor_tag', 'declared_ai_generated', 'generator_tag']);

/** Whether an upload passes the gate. Exported for tests. */
export function gateAllows(gate: 'strict' | 'block' | 'flag', result: Pick<AuthenticityResult, 'outcome' | 'signals'>): boolean {
  if (gate === 'flag') return true;
  if (BLOCKED_MEDIA_OUTCOMES.has(result.outcome)) return false;
  return gate !== 'strict' || !result.signals.some((s) => STRICT_FINDINGS.has(s.finding));
}

export interface ScreenResult {
  allowed: boolean;
  result: AuthenticityResult;
}

/** AI analysis facade: queueing, the staff-facing summary, and media authenticity for evidence. */
export function createAnalysisService(opts: AnalysisServiceOptions) {
  const runner = createAnalysisRunner(opts);
  const provider: AiProvider = opts.provider;
  const gate = opts.mediaUploadGate ?? 'block';
  // Same bytes checked twice (pre-check, then the real upload) cost one model call.
  const screenCache = new Map<string, { result: AuthenticityResult; at: number }>();

  /** Authenticity check run before a file is stored. Throws AppError for unsupported/oversized files. */
  async function screenMedia(bytes: Uint8Array, declaredType: string, context: { complaintTitle: string; complaintDescription: string }): Promise<ScreenResult> {
    const key = `${declaredType}:${createHash('sha256').update(bytes).digest('hex')}`;
    const hit = screenCache.get(key);
    let result = hit && Date.now() - hit.at < SCREEN_CACHE_MS ? hit.result : undefined;
    if (!result) {
      result = await analyzeMedia(bytes, declaredType, context, provider, opts.video);
      if (STABLE_ERRORS.has(result.visualErrorCode)) {
        screenCache.delete(key);
        screenCache.set(key, { result, at: Date.now() });
        if (screenCache.size > SCREEN_CACHE_MAX) screenCache.delete(screenCache.keys().next().value!);
      }
    }
    return { allowed: gateAllows(gate, result), result };
  }

  function requireStaff(relation: string) {
    if (relation === 'reporter') throw new AppError('FORBIDDEN', 'AI analysis is only available to department staff and administrators.');
  }

  /** What the triage agent proposed and which tools it used (agent mode only). Staff view. */
  async function agentView(p: Principal, a: AnalysisDoc) {
    if (!a.agentTrace) return null;
    const [assignee, dup] = await Promise.all([
      a.suggestedAssignee ? User.findById(a.suggestedAssignee).select('name').lean() : null,
      a.likelyDuplicate ? Complaint.findById(a.likelyDuplicate).select('publicId citizen department').lean() : null,
    ]);
    return {
      turns: a.agentTrace.turns,
      toolCalls: (a.agentTrace.steps ?? []).map((s: { tool: string; ok: boolean; ms?: number }) => ({ tool: s.tool, ok: s.ok, ms: s.ms ?? null })),
      proposedAssignee: assignee ? { id: String(assignee._id), name: assignee.name } : null,
      // Only shown if the viewer could open that complaint anyway.
      likelyDuplicate: dup && relationTo(p, { citizen: dup.citizen, department: dup.department }) ? { publicId: dup.publicId } : dup ? { publicId: null } : null,
    };
  }

  async function classificationView(p: Principal, complaintId: Types.ObjectId) {
    const a = (await AIAnalysis.findOne({ complaint: complaintId, analysisType: 'TRIAGE' }).sort({ analysisVersion: -1 }).lean()) as AnalysisDoc | null;
    if (!a) return { status: 'NOT_ANALYZED' as const };
    const dept = a.suggestedDepartment ? await Department.findById(a.suggestedDepartment).select('name').lean() : null;
    return {
      ...jobView(a),
      suggestion:
        a.status === 'SUCCEEDED'
          ? {
              category: a.suggestedCategory ?? null,
              department: dept ? { id: String(dept._id), name: dept.name } : null,
              priority: a.suggestedPriority ?? null,
            }
          : null,
      summary: a.summary ?? null,
      rationale: a.rationale ?? null,
      certainty: a.certainty ?? null,
      // The model's own estimate (not calibrated). Below 0.7 sends the case to a human.
      selfReportedConfidence: a.selfReportedConfidence ?? null,
      publicSafetyHazard: a.publicSafetyHazard ?? null,
      spamLikely: a.spamLikely ?? null,
      // Explainable priority: the model's suggestion and each rule that raised it.
      priority:
        a.status === 'SUCCEEDED'
          ? {
              model: a.modelPriority ?? a.suggestedPriority ?? null,
              final: a.suggestedPriority ?? null,
              factors: (a.priorityFactors ?? []).map((f: { factor: string; detail?: string; raisedTo?: string }) => ({ factor: f.factor, detail: f.detail ?? null, raisedTo: f.raisedTo ?? null })),
            }
          : null,
      locationContext: a.locationContext
        ? {
            ward: a.locationContext.ward ?? null,
            nearbyPlaces: (a.locationContext.nearbyPlaces ?? []).map((pl: { name: string; kind: string; distanceMeters: number }) => ({ name: pl.name, kind: pl.kind, distanceMeters: pl.distanceMeters })),
            openReportsNearby: a.locationContext.openReportsNearby ?? 0,
            linkedReports: a.locationContext.linkedReports ?? 0,
          }
        : null,
      followUpQuestions: a.followUpQuestions ?? [],
      missingInformation: a.missingInformation ?? [],
      reviewRecommended: a.reviewRecommended ?? null,
      reviewReasons: a.reviewFlags ?? [],
      mode: a.agentTrace ? ('agent' as const) : ('single' as const),
      agent: a.status === 'SUCCEEDED' ? await agentView(p, a) : null,
    };
  }

  async function duplicatesView(p: Principal, complaintId: Types.ObjectId) {
    const a = (await AIAnalysis.findOne({ complaint: complaintId, analysisType: 'DUPLICATE_CANDIDATES' }).sort({ analysisVersion: -1 }).lean()) as AnalysisDoc | null;
    if (!a) return { status: 'NOT_ANALYZED' as const, candidates: [], hiddenCandidates: 0 };
    const raw: { complaint: Types.ObjectId; similarity: number; distanceMeters?: number; reason?: string }[] = a.duplicateCandidates ?? [];
    const docs = await Complaint.find({ _id: { $in: raw.map((c) => c.complaint) } })
      .select('publicId title status citizen department createdAt')
      .lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    // Candidates are only shown if the caller could open them anyway.
    const visible = raw.flatMap((c) => {
      const d = byId.get(String(c.complaint));
      if (!d || !relationTo(p, { citizen: d.citizen, department: d.department })) return [];
      return [
        {
          publicId: d.publicId,
          title: d.title,
          status: d.status,
          filedAt: d.createdAt.toISOString(),
          distanceMeters: c.distanceMeters ?? null,
          similarity: c.similarity,
          reason: c.reason ?? null,
        },
      ];
    });
    return { ...jobView(a), candidates: visible, hiddenCandidates: raw.length - visible.length };
  }

  async function authenticityView(complaintId: Types.ObjectId) {
    const evidence = await Evidence.find({ complaint: complaintId }).select('purpose mediaType createdAt').sort({ createdAt: 1 }).lean();
    const [analyses, comparisons] = (await Promise.all([
      AIAnalysis.find({ complaint: complaintId, analysisType: 'MEDIA_AUTHENTICITY' }).sort({ analysisVersion: -1 }).lean(),
      AIAnalysis.find({ complaint: complaintId, analysisType: 'RESOLUTION_COMPARISON' }).sort({ analysisVersion: -1 }).lean(),
    ])) as [AnalysisDoc[], AnalysisDoc[]];
    const comparisonFor = (id: Types.ObjectId) => {
      const c = comparisons.find((x) => String(x.evidence) === String(id));
      if (!c) return undefined;
      if (isActiveStatus(c.status)) return { status: 'PENDING' as const };
      return c.status === 'SUCCEEDED' && c.comparison
        ? { status: 'DONE' as const, sameLocation: c.comparison.sameLocation, issueAppearsFixed: c.comparison.issueAppearsFixed, matchesCategory: c.comparison.matchesCategory, notes: c.comparison.notes ?? '', beforePhotos: c.comparison.beforeCount }
        : { status: 'NOT_COMPARED' as const, errorCode: c.errorCode ?? null };
    };
    return evidence.map((e) => {
      const a = analyses.find((x) => String(x.evidence) === String(e._id));
      const comparison = comparisonFor(e._id);
      const base = { evidenceId: String(e._id), purpose: e.purpose, mediaType: e.mediaType, ...(comparison && { comparison }) };
      if (!a) return { ...base, outcome: 'NOT_ANALYZED' as const };
      if (isActiveStatus(a.status)) return { ...base, outcome: 'ANALYSIS_PENDING' as const, ...jobView(a) };
      return {
        ...base,
        ...jobView(a),
        outcome: a.authenticity?.outcome ?? 'ANALYSIS_FAILED',
        provenance: a.authenticity?.provenance ?? null,
        signals: a.authenticity?.signals ?? [],
        visualModelRun: a.authenticity?.visualModelRun ?? false,
        explanation: a.authenticity?.explanation ?? null,
        reviewRecommended: a.authenticity?.reviewRecommended ?? false,
        relevance: a.relevance ?? null,
      };
    });
  }

  return {
    runner,
    provider,

    /** Queues classification + duplicate check for a new complaint. */
    queueForNewComplaint: (complaintId: Types.ObjectId) => runner.enqueue(complaintId, JOB_TYPES, 'COMPLAINT_CREATED'),
    screenMedia,

    async queueForEvidence(complaintId: Types.ObjectId, evidenceId: Types.ObjectId, requestedBy?: string, purpose?: string, mediaType?: string, screened?: AuthenticityResult) {
      // Privacy copy first, so staff can open the file as soon as possible (videos need ffmpeg).
      if (mediaType !== 'VIDEO' || opts.video?.enabled) await runner.enqueueRedaction(complaintId, evidenceId, requestedBy);
      // Already checked at upload: store that result instead of paying for the same check again.
      const media = screened
        ? await AIAnalysis.create({
            complaint: complaintId,
            evidence: evidenceId,
            analysisType: 'MEDIA_AUTHENTICITY',
            analysisVersion: 1,
            trigger: 'EVIDENCE_ADDED',
            requestedBy,
            attempts: 1,
            status: 'SUCCEEDED',
            startedAt: new Date(),
            completedAt: new Date(),
            ...mediaRecordFields(screened),
          })
        : await runner.enqueueMedia(complaintId, evidenceId, requestedBy);
      if (purpose === 'RESOLUTION') await runner.enqueueComparison(complaintId, evidenceId, requestedBy);
      return media;
    },
    /** Re-runs triage after the citizen answered follow-up questions. */
    queueAfterFollowUp: (complaintId: Types.ObjectId) => runner.enqueue(complaintId, ['TRIAGE'], 'FOLLOW_UP_ANSWERED'),

    /** Staff/admin summary. Reporters get 403; anyone who can't see the complaint gets 404. */
    async summary(p: Principal, publicId: string, complaints: ComplaintService) {
      const { complaintId, relation } = await complaints.access(p, publicId);
      requireStaff(relation);
      const [classification, duplicates, media] = await Promise.all([
        classificationView(p, complaintId),
        duplicatesView(p, complaintId),
        authenticityView(complaintId),
      ]);
      return { aiEnabled: provider.enabled, classification, duplicates, media };
    },

    /** Admin re-run. Returns the existing job if one is already queued or running. */
    async rerun(p: Principal, publicId: string, types: readonly JobType[], complaints: ComplaintService) {
      const { complaintId } = await complaints.access(p, publicId);
      if (!p.roles.has('PLATFORM_ADMIN')) throw new AppError('FORBIDDEN', 'Only platform administrators can re-run analysis.');
      const jobs = await runner.enqueue(complaintId, types, 'MANUAL_RERUN', p.userId);
      return jobs.map((j) => ({ type: j.analysisType, version: j.analysisVersion, status: j.status }));
    },

    /**
     * Authenticity analysis of one evidence file whose bytes the caller already holds (from the
     * future upload pipeline). Runs inline, stores a new versioned record, never changes the
     * complaint or the evidence's verification state.
     */
    async analyzeEvidence(evidenceId: Types.ObjectId | string, bytes: Uint8Array, requestedBy?: string) {
      const ev = await Evidence.findById(evidenceId).lean();
      if (!ev) throw notFoundError('The evidence');
      const complaint = await Complaint.findById(ev.complaint).select('title description').lean();
      if (!complaint) throw notFoundError('The complaint');
      const latest = await AIAnalysis.findOne({ complaint: ev.complaint, analysisType: 'MEDIA_AUTHENTICITY', evidence: ev._id }).sort({ analysisVersion: -1 }).select('analysisVersion').lean();
      const base = {
        complaint: ev.complaint,
        evidence: ev._id,
        analysisType: 'MEDIA_AUTHENTICITY' as const,
        analysisVersion: (latest?.analysisVersion ?? 0) + 1,
        trigger: 'EVIDENCE_ADDED' as const,
        requestedBy,
        attempts: 1,
        startedAt: new Date(),
      };
      try {
        const result = await analyzeMedia(bytes, ev.contentType, { complaintTitle: complaint.title, complaintDescription: complaint.description }, provider, opts.video);
        return await AIAnalysis.create({ ...base, status: 'SUCCEEDED', completedAt: new Date(), ...mediaRecordFields(result) });
      } catch (err) {
        const code = err instanceof AppError ? err.code : 'INTERNAL_ERROR';
        await AIAnalysis.create({
          ...base,
          status: 'FAILED',
          completedAt: new Date(),
          provider: 'civicfix-rules',
          modelName: 'metadata-v1',
          errorCode: code,
          authenticity: {
            outcome: 'ANALYSIS_FAILED',
            provenance: 'NOT_PRESENT',
            signals: [],
            visualModelRun: false,
            explanation: 'The file could not be analysed.',
            reviewRecommended: false,
          },
        });
        throw err;
      }
    },
  };
}
export type AnalysisService = ReturnType<typeof createAnalysisService>;
