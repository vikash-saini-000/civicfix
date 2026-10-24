import { Types } from 'mongoose';
import type { AiProvider } from '../../ai/types.js';
import type { Principal } from '../../auth/roles.js';
import { AIAnalysis, Complaint, Department, Evidence } from '../../models/index.js';
import { AppError, notFoundError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { relationTo, type ComplaintService } from '../complaints.js';
import { analyzeMedia, mediaRecordFields } from './mediaAuthenticity.js';
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
}

/** AI analysis facade: queueing, the staff-facing summary, and media authenticity for evidence. */
export function createAnalysisService(opts: AnalysisServiceOptions) {
  const runner = createAnalysisRunner(opts);
  const provider: AiProvider = opts.provider;

  function requireStaff(relation: string) {
    if (relation === 'reporter') throw new AppError('FORBIDDEN', 'AI analysis is only available to department staff and administrators.');
  }

  async function classificationView(complaintId: Types.ObjectId) {
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
      missingInformation: a.missingInformation ?? [],
      reviewRecommended: a.reviewRecommended ?? null,
      reviewReasons: a.reviewFlags ?? [],
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
    const analyses = (await AIAnalysis.find({ complaint: complaintId, analysisType: 'MEDIA_AUTHENTICITY' }).sort({ analysisVersion: -1 }).lean()) as AnalysisDoc[];
    return evidence.map((e) => {
      const a = analyses.find((x) => String(x.evidence) === String(e._id));
      const base = { evidenceId: String(e._id), purpose: e.purpose, mediaType: e.mediaType };
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
    queueForEvidence: (complaintId: Types.ObjectId, evidenceId: Types.ObjectId, requestedBy?: string) => runner.enqueueMedia(complaintId, evidenceId, requestedBy),

    /** Staff/admin summary. Reporters get 403; anyone who can't see the complaint gets 404. */
    async summary(p: Principal, publicId: string, complaints: ComplaintService) {
      const { complaintId, relation } = await complaints.access(p, publicId);
      requireStaff(relation);
      const [classification, duplicates, media] = await Promise.all([
        classificationView(complaintId),
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
        const result = await analyzeMedia(bytes, ev.contentType, { complaintTitle: complaint.title, complaintDescription: complaint.description }, provider);
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
