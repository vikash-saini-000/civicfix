// Background analysis jobs, stored in MongoDB (AIAnalysis records in PENDING/RUNNING state).
//
// Durability: jobs are rows, not in-memory tasks. A crash leaves them PENDING or RUNNING with a lease;
// the periodic sweep picks up due PENDING jobs and RUNNING jobs whose lease expired. Each claim counts
// as an attempt, so a job that keeps crashing the worker stops after maxAttempts.
// Limits: one process polls; there is no cross-process priority or fairness. Fine at this scale.
import { Types } from 'mongoose';
import { AiProviderError, type AiProvider } from '../../ai/types.js';
import { AIAnalysis, AuditLog, Complaint, Department, Evidence } from '../../models/index.js';
import type { ObjectStorage } from '../../storage/index.js';
import { analyzeMedia, mediaRecordFields } from './mediaAuthenticity.js';
import type { AnalysisTrigger, Category } from '../../models/enums.js';
import { transitionFor } from '../../policies/complaintLifecycle.js';
import { safeError } from '../../config/database.js';
import type { Logger } from '../../utils/logger.js';
import type { EventBus } from '../../events/bus.js';
import { AppError } from '../../utils/errors.js';
import { DEFAULT_DUPLICATE_SETTINGS, DUPLICATE_METHOD, ensureEmbeddings, findDuplicateCandidates, semanticMethod, type DuplicateSettings } from './duplicates.js';
import { MAX_VISUAL_MODEL_BYTES } from './mediaAuthenticity.js';
import { runTriageAgent } from './triageAgent.js';
import { DEFAULT_MAX_OPEN_PER_MEMBER } from '../staffCapacity.js';
import type { ImageData } from '../../ai/types.js';
import { disabledEmbeddings, type EmbeddingProvider } from '../../ai/embeddings.js';
import { adjustPriority, contextForPrompt, DEFAULT_PRIORITY_POLICY, locationContext, type PriorityPolicy } from '../location.js';
import { redactImage, type RedactionRegion } from './redaction.js';
import { disabledVideoTools, sampleTimes, VideoProcessingError, type TimedRegion, type VideoTools } from '../../media/video.js';
import type { Priority, ReviewReason } from '../../models/enums.js';

export const JOB_TYPES = ['TRIAGE', 'DUPLICATE_CANDIDATES'] as const;
export type JobType = (typeof JOB_TYPES)[number];
/** Everything the runner processes, including per-evidence media checks. */
const RUNNABLE_TYPES = [...JOB_TYPES, 'MEDIA_AUTHENTICITY', 'RESOLUTION_COMPARISON', 'PRIVACY_REDACTION'] as const;
type EvidenceJobType = 'MEDIA_AUTHENTICITY' | 'RESOLUTION_COMPARISON' | 'PRIVACY_REDACTION';
const isEvidenceJob = (t: string) => t === 'MEDIA_AUTHENTICITY' || t === 'RESOLUTION_COMPARISON' || t === 'PRIVACY_REDACTION';

/** Below this self-reported confidence the case goes to a human (proposal: "confidence < 0.7 → human review"). */
export const MIN_ROUTING_CONFIDENCE = 0.7;
/** How long a duplicate check waits for the complaint's triage summary before using the raw text. */
const DUPLICATE_WAIT_FOR_TRIAGE_MS = 90_000;

/** Thrown by a job that must wait for another job; it is rescheduled without counting an attempt. */
class DeferJob extends Error {
  constructor(readonly delayMs: number) {
    super('deferred');
  }
}

/** Total raw image bytes in one comparison request (about 8 MB once base64-encoded). */
const MAX_COMPARISON_BYTES = 6 * 1024 * 1024;
/** Most frames checked for faces/plates in one video (one model call each). */
const MAX_PRIVACY_FRAMES = 12;

export const TRIAGE_MODES = ['single', 'agent'] as const;
export type TriageMode = (typeof TRIAGE_MODES)[number];

export interface RunnerOptions {
  provider: AiProvider;
  logger: Logger;
  maxAttempts: number;
  /** Process jobs automatically after enqueue and on the sweep timer. Off in most tests (use drain()). */
  autoRun: boolean;
  concurrency?: number;
  leaseMs?: number;
  retryBaseMs?: number;
  duplicateSettings?: DuplicateSettings;
  /** Where evidence bytes are read from for MEDIA_AUTHENTICITY jobs. */
  storage?: ObjectStorage;
  /** Cap on departments offered to the model in one prompt. */
  maxDepartmentsInPrompt?: number;
  /** `single` = one classification call; `agent` = bounded tool-using triage agent. Default single. */
  triageMode?: TriageMode;
  /** Max model calls per agent run (agent mode). */
  agentMaxTurns?: number;
  /** Per-call provider timeout, used to size the job lease in agent mode. */
  callTimeoutMs?: number;
  /** Capacity rule shared with automatic assignment. */
  maxOpenPerMember?: number;
  /** ffmpeg tools for video frames, details and privacy copies. Disabled = videos get metadata-only checks. */
  video?: VideoTools;
  /** Semantic duplicate search. Disabled = word-overlap only. */
  embeddings?: EmbeddingProvider;
  priorityPolicy?: PriorityPolicy;
}

const activeKey = (complaint: Types.ObjectId | string, type: string, evidence?: Types.ObjectId | string | null) =>
  `${String(complaint)}:${type}:${evidence ? String(evidence) : '-'}`;

const isDuplicateKey = (err: unknown) => (err as { code?: number }).code === 11000;

export function createAnalysisRunner(opts: RunnerOptions) {
  const { provider, logger } = opts;
  const concurrency = opts.concurrency ?? 2;
  const triageMode: TriageMode = opts.triageMode ?? 'single';
  const agentMaxTurns = opts.agentMaxTurns ?? 6;
  const callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  const video = opts.video ?? disabledVideoTools;
  // The lease must outlast a whole agent run (or a video privacy copy), or another worker could pick the job up mid-run.
  const leaseMs = opts.leaseMs ?? Math.max(video.enabled ? 240_000 : 90_000, triageMode === 'agent' ? (agentMaxTurns + 1) * callTimeoutMs : 0);
  const agentDeadlineMs = Math.max(10_000, leaseMs - 10_000);
  const retryBaseMs = opts.retryBaseMs ?? 2_000;
  const dupSettings = opts.duplicateSettings ?? DEFAULT_DUPLICATE_SETTINGS;
  const maxDepartments = opts.maxDepartmentsInPrompt ?? 50;
  const embeddings = opts.embeddings ?? disabledEmbeddings;
  const priorityPolicy = opts.priorityPolicy ?? DEFAULT_PRIORITY_POLICY;

  const running = new Set<Promise<void>>();
  let timer: NodeJS.Timeout | undefined;
  // Called after a TRIAGE or DUPLICATE_CANDIDATES job reaches a final state (e.g. automatic assignment).
  let onJobFinished: ((complaintId: Types.ObjectId) => Promise<unknown>) | null = null;
  let events: EventBus | null = null;
  let stopping = false;

  /** Creates a PENDING job, or returns the one already active for the same complaint + type. */
  async function enqueueOne(
    complaintId: Types.ObjectId | string,
    type: JobType | EvidenceJobType,
    trigger: AnalysisTrigger,
    requestedBy?: string,
    evidence?: Types.ObjectId | string,
  ) {
    const key = activeKey(complaintId, type, evidence);
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await AIAnalysis.findOne({ complaint: complaintId, analysisType: type, evidence: evidence ?? null }).sort({ analysisVersion: -1 }).select('analysisVersion').lean();
      try {
        return await AIAnalysis.create({
          complaint: complaintId,
          analysisType: type,
          evidence,
          status: 'PENDING',
          analysisVersion: (latest?.analysisVersion ?? 0) + 1,
          trigger,
          requestedBy,
          activeJobKey: key,
          attempts: 0,
          nextAttemptAt: new Date(),
          provider: type === 'DUPLICATE_CANDIDATES' ? DUPLICATE_METHOD.provider : provider.name,
          modelName: type === 'DUPLICATE_CANDIDATES' ? (embeddings.enabled ? semanticMethod(embeddings.model).modelName : DUPLICATE_METHOD.modelName) : provider.model,
        });
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        const active = await AIAnalysis.findOne({ activeJobKey: key });
        if (active) return active; // already queued or running: no extra work
        // Otherwise two enqueues raced on the version number; retry with a fresh one.
      }
    }
    throw new Error('Could not enqueue analysis');
  }

  async function finish(id: Types.ObjectId, set: Record<string, unknown>) {
    await AIAnalysis.updateOne(
      { _id: id },
      { $set: { ...set, completedAt: new Date() }, $unset: { activeJobKey: 1, lockedUntil: 1, nextAttemptAt: 1 } },
    );
  }

  /** Returns true when the job reached a final state. */
  async function failOrRetry(job: { _id: Types.ObjectId; attempts: number; analysisType: string }, err: unknown): Promise<boolean> {
    const providerErr = err instanceof AiProviderError ? err : null;
    // Known application errors (e.g. unsupported file) are final; unexpected errors are treated as transient.
    const appErr = err instanceof AppError ? err : null;
    const retryable = providerErr ? providerErr.retryable : !appErr;
    const code = providerErr?.kind ?? appErr?.code ?? 'INTERNAL_ERROR';
    if (retryable && job.attempts < opts.maxAttempts) {
      // Exponential backoff with jitter, capped at one minute.
      const delay = Math.min(60_000, retryBaseMs * 2 ** (job.attempts - 1)) + Math.floor(Math.random() * retryBaseMs);
      await AIAnalysis.updateOne(
        { _id: job._id },
        { $set: { status: 'PENDING', errorCode: code, nextAttemptAt: new Date(Date.now() + delay) }, $unset: { lockedUntil: 1 } },
      );
      logger.warn({ analysisId: String(job._id), type: job.analysisType, attempt: job.attempts, errorCode: code }, 'analysis attempt failed; will retry');
      return false;
    }
    await finish(job._id, { status: code === 'INVALID_OUTPUT' ? 'INVALID_OUTPUT' : 'FAILED', errorCode: code });
    const level = code === 'NOT_CONFIGURED' ? 'info' : 'warn';
    logger[level]({ analysisId: String(job._id), type: job.analysisType, attempts: job.attempts, errorCode: code, providerDetail: providerErr?.detail, err: providerErr ? undefined : safeError(err) }, 'analysis failed');
    return true;
  }

  async function runTriage(job: { _id: Types.ObjectId; complaint: Types.ObjectId }) {
    const complaint = await Complaint.findById(job.complaint)
      .select('title description landmark selectedCategory confirmedCategory status location createdAt ward linkedReportCount followUp spamCheck')
      .lean();
    if (!complaint) {
      await finish(job._id, { status: 'FAILED', errorCode: 'COMPLAINT_NOT_FOUND' });
      return;
    }
    // Location facts first: they go into the prompt, decide which departments serve this place, and drive priority.
    let ctx = await locationContext(complaint as never, complaint.selectedCategory ?? null, priorityPolicy);
    const wardId = ctx.ward?.id ?? null;
    const departments = await Department.find({ isActive: true, $or: [{ wards: { $size: 0 } }, ...(wardId ? [{ wards: wardId }] : [])] })
      .sort({ name: 1 })
      .limit(maxDepartments)
      .select('name categories')
      .lean();
    const options = departments.map((d, i) => ({ ref: `D${i + 1}`, name: d.name, categories: [...d.categories], id: d._id }));
    const followUp = complaint.followUp?.answeredAt
      ? complaint.followUp.questions.map((q, i) => ({ question: q, answer: complaint.followUp!.answers[i] ?? '' })).filter((x) => x.answer)
      : null;
    const promptContext = contextForPrompt(ctx);

    const agent =
      triageMode === 'agent' && provider.runAgent && options.length > 0
        ? await runTriageAgent(provider, complaint as never, options, {
            maxTurns: agentMaxTurns,
            deadlineMs: agentDeadlineMs,
            maxOpenPerMember: opts.maxOpenPerMember ?? DEFAULT_MAX_OPEN_PER_MEMBER,
            duplicateSettings: dupSettings,
            embeddings,
            locationContext: promptContext,
            followUp,
          })
        : null;
    const { output, meta } =
      agent ??
      (await provider.classifyComplaint({
        title: complaint.title,
        description: complaint.description,
        landmark: complaint.landmark ?? null,
        citizenCategory: complaint.selectedCategory ?? null,
        departments: options.map(({ ref, name, categories }) => ({ ref, name, categories })),
        locationContext: promptContext,
        followUp,
      }));

    // The model may only point at an offered department, and it must handle the suggested category.
    const flags = new Set<ReviewReason>(output.reviewReasons);
    for (const r of agent?.requestedReview ?? []) flags.add(r);
    let department = options.find((o) => o.ref === output.departmentRef) ?? null;
    if (department && !department.categories.includes(output.category)) {
      department = null;
      flags.add('UNCLEAR_DEPARTMENT');
    }
    if (!department) flags.add('UNCLEAR_DEPARTMENT');
    if (output.certainty === 'LOW' || output.confidence < MIN_ROUTING_CONFIDENCE) flags.add('LOW_CONFIDENCE');
    if (output.priority === 'P1') flags.add('HIGH_URGENCY');
    if (output.publicSafetyHazard) flags.add('PUBLIC_SAFETY_HAZARD');
    if (output.spamLikely || complaint.spamCheck?.signals?.length && (complaint.spamCheck.score ?? 0) >= 0.6) flags.add('SPAM_SUSPECTED');
    if (agent?.likelyDuplicate) flags.add('AMBIGUOUS_DUPLICATE');
    // An agent-proposed assignee only counts if it belongs to the department that survived the checks above.
    const assignee = agent?.assignee && department && agent.assignee.department.equals(department.id) ? agent.assignee.user : null;

    // Explainable priority: the model's suggestion, raised by listed location/volume/age factors.
    if (output.category !== (complaint.selectedCategory ?? null)) ctx = await locationContext(complaint as never, output.category, priorityPolicy);
    const decided = adjustPriority(output.priority as Priority, output.category, ctx, priorityPolicy);

    // Ask the citizen once. Questions matter for routing only when the model is unsure.
    const questions = output.followUpQuestions.slice(0, 3);
    const askNow = questions.length > 0 && !complaint.followUp;
    if (askNow && (flags.has('LOW_CONFIDENCE') || flags.has('UNCLEAR_DEPARTMENT'))) flags.add('AWAITING_CITIZEN_INFO');

    await finish(job._id, {
      status: 'SUCCEEDED',
      errorCode: null,
      provider: meta.provider,
      modelName: meta.model,
      promptVersion: meta.promptVersion,
      latencyMs: meta.latencyMs,
      usage: { inputTokens: meta.inputTokens, outputTokens: meta.outputTokens },
      suggestedCategory: output.category as Category,
      suggestedPriority: decided.priority,
      modelPriority: output.priority,
      priorityFactors: decided.factors,
      suggestedDepartment: department?.id ?? null,
      summary: output.summary,
      rationale: output.rationale,
      missingInformation: output.missingInformation,
      certainty: output.certainty,
      selfReportedConfidence: output.confidence,
      publicSafetyHazard: output.publicSafetyHazard,
      spamLikely: output.spamLikely,
      followUpQuestions: questions,
      locationContext: {
        ward: ctx.ward?.name,
        nearbyPlaces: ctx.nearbyPlaces.slice(0, 8),
        openReportsNearby: ctx.openReportsNearby,
        linkedReports: ctx.linkedReports,
      },
      reviewFlags: [...flags],
      reviewRecommended: output.reviewRecommended || flags.size > 0,
      ...(agent && {
        suggestedAssignee: assignee,
        likelyDuplicate: agent.likelyDuplicate,
        agentTrace: { turns: agent.turns, steps: agent.steps.slice(0, 30) },
      }),
    });
    if (agent && agent.droppedRefs.length > 0) logger.info({ analysisId: String(job._id), droppedRefs: agent.droppedRefs.length }, 'agent proposed refs that did not resolve');

    if (askNow) {
      const asked = await Complaint.updateOne({ _id: job.complaint, followUp: null }, { $set: { followUp: { questions, askedAt: new Date(), answers: [] } } });
      if (asked.modifiedCount === 1) await events?.emit('complaint.follow_up_requested', { complaintId: String(job.complaint), count: questions.length }, `${job.complaint}:follow-up`);
    }
    // Summary embedding for semantic duplicate search (best effort; the duplicate check waits for it).
    if (embeddings.enabled) {
      await ensureEmbeddings([job.complaint], embeddings).catch((err) => logger.warn({ err: safeError(err) }, 'embedding failed; duplicate search falls back to wording'));
    }

    // Only allowed side effect: a REPORTED complaint moves to UNDER_REVIEW. Routing stays with humans.
    const { from, to } = transitionFor('start_review');
    const moved = await Complaint.updateOne(
      { _id: job.complaint, status: { $in: from } },
      { $set: { status: to }, $push: { statusHistory: { status: to, at: new Date(), publicNote: 'We are checking the details and looking for similar reports nearby.' } } },
    );
    if (moved.modifiedCount === 1) {
      await AuditLog.create({
        actorType: 'AI',
        action: 'complaint.review_started',
        targetType: 'Complaint',
        targetId: job.complaint,
        outcome: 'SUCCESS',
        reason: 'automatic analysis completed',
        changes: [{ field: 'status', before: 'REPORTED', after: 'UNDER_REVIEW' }],
      });
      await events?.emit('complaint.status_changed', { complaintId: String(job.complaint), from: 'REPORTED', to: 'UNDER_REVIEW' }, `${job.complaint}:UNDER_REVIEW:ai:${job._id}`);
    }
  }

  async function runDuplicates(job: { _id: Types.ObjectId; complaint: Types.ObjectId; createdAt?: Date }) {
    const complaint = await Complaint.findById(job.complaint).select('title description location createdAt selectedCategory confirmedCategory').lean();
    if (!complaint) {
      await finish(job._id, { status: 'FAILED', errorCode: 'COMPLAINT_NOT_FOUND' });
      return;
    }
    // Semantic search compares English AI summaries, so give triage a moment to produce one.
    if (embeddings.enabled && Date.now() - (job.createdAt?.getTime() ?? 0) < DUPLICATE_WAIT_FOR_TRIAGE_MS) {
      const triageActive = await AIAnalysis.exists({ complaint: job.complaint, analysisType: 'TRIAGE', status: { $in: ['PENDING', 'RUNNING'] } });
      if (triageActive) throw new DeferJob(3_000);
    }
    const started = Date.now();
    let candidates;
    let method = DUPLICATE_METHOD as { provider: string; modelName: string };
    try {
      candidates = await findDuplicateCandidates(complaint as never, dupSettings, embeddings);
      if (embeddings.enabled) method = semanticMethod(embeddings.model);
    } catch (err) {
      // Embedding outage: fall back to wording so routing is never blocked by it.
      if (!(err instanceof AiProviderError)) throw err;
      logger.warn({ errorCode: err.kind }, 'semantic duplicate search unavailable; using wording');
      candidates = await findDuplicateCandidates(complaint as never, dupSettings);
    }
    await finish(job._id, {
      status: 'SUCCEEDED',
      errorCode: null,
      provider: method.provider,
      modelName: method.modelName,
      latencyMs: Date.now() - started,
      duplicateCandidates: candidates,
      reviewFlags: candidates.length > 0 ? ['AMBIGUOUS_DUPLICATE'] : [],
      reviewRecommended: candidates.length > 0,
    });
  }

  async function runMedia(job: { _id: Types.ObjectId; evidence?: Types.ObjectId | null }) {
    const ev = job.evidence ? await Evidence.findById(job.evidence).lean() : null;
    if (!ev) {
      await finish(job._id, { status: 'FAILED', errorCode: 'EVIDENCE_NOT_FOUND' });
      return;
    }
    if (!opts.storage?.enabled) throw new AiProviderError('UNAVAILABLE', 'storage not available');
    const [bytes, complaint] = await Promise.all([opts.storage.get(ev.storageKey), Complaint.findById(ev.complaint).select('title description').lean()]);
    const result = await analyzeMedia(bytes, ev.contentType, { complaintTitle: complaint?.title ?? '', complaintDescription: complaint?.description ?? '' }, provider, video);
    await finish(job._id, { status: 'SUCCEEDED', ...mediaRecordFields(result) });
  }

  /**
   * Before/after comparison for one RESOLUTION photo. Advisory only: verification uses it solely to
   * make the outcome more cautious. Files the model can't take are recorded as not comparable.
   */
  async function runComparison(job: { _id: Types.ObjectId; evidence?: Types.ObjectId | null }) {
    const after = job.evidence ? await Evidence.findById(job.evidence).lean() : null;
    if (!after) {
      await finish(job._id, { status: 'FAILED', errorCode: 'EVIDENCE_NOT_FOUND' });
      return;
    }
    const comparable = (e: { mediaType: string; sizeBytes: number }) => (e.mediaType === 'VIDEO' ? video.enabled : e.sizeBytes <= MAX_VISUAL_MODEL_BYTES);
    if (!comparable(after)) {
      await finish(job._id, { status: 'FAILED', errorCode: 'NOT_COMPARABLE' });
      return;
    }
    if (!provider.compareResolution) throw new AiProviderError('NOT_CONFIGURED', 'comparison not supported');
    if (!opts.storage?.enabled) throw new AiProviderError('UNAVAILABLE', 'storage not available');
    const storage = opts.storage;
    const complaint = await Complaint.findById(after.complaint).select('title description selectedCategory confirmedCategory').lean();
    // Videos are compared through their middle frame. Up to two of the citizen's own photos/videos, oldest
    // first, while the request stays small: base64 adds a third, and gateways cap request bodies (AiCredits.in: 10 MB).
    const asImage = async (e: { storageKey: string; contentType: string; mediaType: string }): Promise<Buffer | ImageData> => {
      const bytes = Buffer.from(await storage.get(e.storageKey));
      if (e.mediaType !== 'VIDEO') return { mediaType: e.contentType as ImageData['mediaType'], base64: bytes.toString('base64') };
      try {
        const [frame] = await video.frames(bytes, { count: 1, maxWidth: 1280 });
        return { mediaType: 'image/jpeg', base64: frame!.jpeg.toString('base64') };
      } catch (err) {
        if (err instanceof VideoProcessingError && err.kind === 'UNREADABLE') return bytes; // not comparable
        throw new AiProviderError('UNAVAILABLE', 'video frames unavailable');
      }
    };
    const afterImage = await asImage(after);
    if (Buffer.isBuffer(afterImage)) {
      await finish(job._id, { status: 'FAILED', errorCode: 'NOT_COMPARABLE' });
      return;
    }
    let budget = MAX_COMPARISON_BYTES - (afterImage.base64.length * 3) / 4;
    const candidates = (
      await Evidence.find({ complaint: after.complaint, purpose: { $in: ['COMPLAINT_REPORT', 'ADDITIONAL'] } })
        .sort({ createdAt: 1 })
        .limit(5)
        .select('storageKey contentType sizeBytes mediaType')
        .lean()
    ).filter(comparable);
    const before: ImageData[] = [];
    for (const doc of candidates) {
      if (before.length >= 2) break;
      const img = await asImage(doc);
      if (Buffer.isBuffer(img)) continue;
      if ((budget -= (img.base64.length * 3) / 4) < 0) break;
      before.push(img);
    }
    const { output, meta } = await provider.compareResolution({
      before,
      after: afterImage!,
      category: complaint?.confirmedCategory ?? complaint?.selectedCategory ?? 'other',
      complaintTitle: complaint?.title ?? '',
      complaintDescription: complaint?.description ?? '',
    });
    const cautious = output.issueAppearsFixed !== 'YES' || output.sameLocation === 'NO' || output.matchesCategory === 'NO';
    await finish(job._id, {
      status: 'SUCCEEDED',
      errorCode: null,
      provider: meta.provider,
      modelName: meta.model,
      promptVersion: meta.promptVersion,
      latencyMs: meta.latencyMs,
      usage: { inputTokens: meta.inputTokens, outputTokens: meta.outputTokens },
      comparison: { ...output, beforeCount: before.length },
      reviewRecommended: cautious,
    });
  }

  /**
   * Shareable copy of one image: metadata stripped, faces and number plates pixelated where the model
   * found them. Model failures fall back to a metadata-only copy once retries are used up.
   */
  async function runRedaction(job: { _id: Types.ObjectId; evidence?: Types.ObjectId | null; attempts: number }) {
    const ev = job.evidence ? await Evidence.findById(job.evidence).lean() : null;
    if (!ev) {
      await finish(job._id, { status: 'FAILED', errorCode: 'EVIDENCE_NOT_FOUND' });
      return;
    }
    if (ev.mediaType === 'VIDEO' && video.enabled) return runVideoRedaction(job, ev);
    if (ev.mediaType !== 'IMAGE') {
      await Evidence.updateOne({ _id: ev._id }, { $set: { redaction: { state: 'NOT_SUPPORTED', updatedAt: new Date() } } });
      await finish(job._id, { status: 'FAILED', errorCode: 'NOT_SUPPORTED' });
      return;
    }
    if (!opts.storage?.enabled) throw new AiProviderError('UNAVAILABLE', 'storage not available');
    const storage = opts.storage;
    const bytes = await storage.get(ev.storageKey);

    let regions: RedactionRegion[] = [];
    let modelRan = false;
    let meta: { provider?: string; model?: string; promptVersion?: string; latencyMs?: number; inputTokens?: number; outputTokens?: number } = {};
    if (provider.enabled && provider.detectPrivacyRegions && ev.sizeBytes <= MAX_VISUAL_MODEL_BYTES) {
      try {
        const res = await provider.detectPrivacyRegions({ mediaType: ev.contentType as ImageData['mediaType'], base64: Buffer.from(bytes).toString('base64') });
        regions = res.output.regions;
        meta = res.meta;
        modelRan = true;
      } catch (err) {
        const retryable = err instanceof AiProviderError ? err.retryable : true;
        if (retryable && job.attempts < opts.maxAttempts) throw err;
        logger.warn({ evidenceId: String(ev._id), errorCode: err instanceof AiProviderError ? err.kind : 'INTERNAL_ERROR' }, 'privacy detection failed; sharing a metadata-only copy');
      }
    }

    let redacted: Buffer;
    try {
      redacted = await redactImage(bytes, ev.contentType, regions);
    } catch {
      await Evidence.updateOne({ _id: ev._id }, { $set: { redaction: { state: 'FAILED', updatedAt: new Date() } } });
      await finish(job._id, { status: 'FAILED', errorCode: 'UNREADABLE_IMAGE' });
      return;
    }
    const key = ev.storageKey.replace(/\.([a-z0-9]+)$/, '.shared.$1');
    await storage.delete(key).catch(() => undefined); // a retry may have written it already
    await storage.put(key, redacted, ev.contentType);
    const faces = regions.filter((r) => r.kind === 'FACE').length;
    const licensePlates = regions.length - faces;
    await Evidence.updateOne(
      { _id: ev._id },
      { $set: { redaction: { state: modelRan ? 'DONE' : 'METADATA_ONLY', storageKey: key, contentType: ev.contentType, faces, licensePlates, updatedAt: new Date() } } },
    );
    await finish(job._id, {
      status: 'SUCCEEDED',
      errorCode: null,
      ...(modelRan && { provider: meta.provider, modelName: meta.model, promptVersion: meta.promptVersion, latencyMs: meta.latencyMs, usage: { inputTokens: meta.inputTokens, outputTokens: meta.outputTokens } }),
      ...(!modelRan && { provider: 'civicfix-rules', modelName: 'metadata-strip-v1' }),
      redaction: { regions },
    });
  }

  /**
   * Shareable copy of one video: frames sampled about every 2 s (up to MAX_PRIVACY_FRAMES) are checked for
   * faces and number plates; each box found is pixelated from the previous sample to the next one, so
   * things that move between samples stay covered. All metadata is removed and the copy is an MP4.
   */
  async function runVideoRedaction(job: { _id: Types.ObjectId; attempts: number }, ev: { _id: Types.ObjectId; storageKey: string }) {
    if (!opts.storage?.enabled) throw new AiProviderError('UNAVAILABLE', 'storage not available');
    const storage = opts.storage;
    const bytes = await storage.get(ev.storageKey);
    const fail = async (code: string) => {
      await Evidence.updateOne({ _id: ev._id }, { $set: { redaction: { state: 'FAILED', updatedAt: new Date() } } });
      await finish(job._id, { status: 'FAILED', errorCode: code });
    };

    let probe;
    try {
      probe = await video.probe(bytes);
    } catch (err) {
      if (err instanceof VideoProcessingError && err.kind === 'UNREADABLE') return fail('UNREADABLE_VIDEO');
      throw new AiProviderError('UNAVAILABLE', 'video tools failed');
    }

    const timed: TimedRegion[] = [];
    const found: { kind: 'FACE' | 'LICENSE_PLATE'; x: number; y: number; width: number; height: number }[] = [];
    let modelRan = false;
    let maxFaces = 0;
    let maxPlates = 0;
    let meta: { provider?: string; model?: string; promptVersion?: string; latencyMs?: number; inputTokens?: number; outputTokens?: number } = {};
    if (provider.enabled && provider.detectPrivacyRegions) {
      const times = sampleTimes(probe.durationSec, Math.min(MAX_PRIVACY_FRAMES, Math.max(2, Math.ceil(probe.durationSec / 2))));
      try {
        const frames = await video.frames(bytes, { atSec: times, maxWidth: 1024 });
        const results: Awaited<ReturnType<NonNullable<AiProvider['detectPrivacyRegions']>>>[] = [];
        // A few calls at a time keeps the job inside its lease without flooding the provider.
        for (let i = 0; i < frames.length; i += 4) {
          results.push(...(await Promise.all(frames.slice(i, i + 4).map((f) => provider.detectPrivacyRegions!({ mediaType: 'image/jpeg', base64: f.jpeg.toString('base64') })))));
        }
        frames.forEach((f, i) => {
          const res = results[i]!;
          meta = res.meta;
          const startSec = i === 0 ? 0 : frames[i - 1]!.atSec;
          const endSec = i === frames.length - 1 ? probe.durationSec + 1 : frames[i + 1]!.atSec;
          for (const r of res.output.regions) {
            timed.push({ x: r.x, y: r.y, width: r.width, height: r.height, startSec, endSec });
            if (found.length < 40) found.push(r);
          }
          maxFaces = Math.max(maxFaces, res.output.regions.filter((r) => r.kind === 'FACE').length);
          maxPlates = Math.max(maxPlates, res.output.regions.filter((r) => r.kind === 'LICENSE_PLATE').length);
        });
        modelRan = true;
      } catch (err) {
        const retryable = err instanceof AiProviderError ? err.retryable : true;
        if (retryable && job.attempts < opts.maxAttempts) throw err;
        timed.length = 0;
        logger.warn({ evidenceId: String(ev._id), errorCode: err instanceof AiProviderError ? err.kind : 'INTERNAL_ERROR' }, 'video privacy detection failed; sharing a metadata-only copy');
      }
    }

    let redacted: Buffer;
    try {
      redacted = await video.redact(bytes, timed);
    } catch (err) {
      if (err instanceof VideoProcessingError && err.kind === 'UNREADABLE') return fail('UNREADABLE_VIDEO');
      if (job.attempts < opts.maxAttempts) throw new AiProviderError('UNAVAILABLE', 'video encode failed');
      return fail('VIDEO_ENCODE_FAILED');
    }
    const key = ev.storageKey.replace(/\.([a-z0-9]+)$/, '.shared.mp4');
    await storage.delete(key).catch(() => undefined); // a retry may have written it already
    await storage.put(key, redacted, 'video/mp4');
    await Evidence.updateOne(
      { _id: ev._id },
      { $set: { redaction: { state: modelRan ? 'DONE' : 'METADATA_ONLY', storageKey: key, contentType: 'video/mp4', faces: maxFaces, licensePlates: maxPlates, updatedAt: new Date() } } },
    );
    await finish(job._id, {
      status: 'SUCCEEDED',
      errorCode: null,
      ...(modelRan && { provider: meta.provider, modelName: meta.model, promptVersion: meta.promptVersion, latencyMs: meta.latencyMs, usage: { inputTokens: meta.inputTokens, outputTokens: meta.outputTokens } }),
      ...(!modelRan && { provider: 'civicfix-rules', modelName: 'metadata-strip-v1' }),
      redaction: { regions: found },
    });
  }

  /** Claims one due job (PENDING and due, or RUNNING with an expired lease). */
  async function claim() {
    const now = new Date();
    return AIAnalysis.findOneAndUpdate(
      {
        analysisType: { $in: RUNNABLE_TYPES },
        $or: [
          { status: 'PENDING', nextAttemptAt: { $lte: now } },
          { status: 'RUNNING', lockedUntil: { $lt: now } },
        ],
      },
      { $set: { status: 'RUNNING', lockedUntil: new Date(now.getTime() + leaseMs), startedAt: now }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
    ).lean();
  }

  async function processOne(): Promise<boolean> {
    const job = await claim();
    if (!job) return false;
    let final = true;
    if (job.attempts > opts.maxAttempts) {
      await finish(job._id, { status: 'FAILED', errorCode: job.errorCode ?? 'MAX_ATTEMPTS' });
    } else {
      try {
        if (job.analysisType === 'TRIAGE') await runTriage(job);
        else if (job.analysisType === 'MEDIA_AUTHENTICITY') await runMedia(job);
        else if (job.analysisType === 'RESOLUTION_COMPARISON') await runComparison(job);
        else if (job.analysisType === 'PRIVACY_REDACTION') await runRedaction(job);
        else await runDuplicates(job);
        logger.info({ analysisId: String(job._id), type: job.analysisType, attempt: job.attempts }, 'analysis completed');
      } catch (err) {
        if (err instanceof DeferJob) {
          // Waiting on another job: back to PENDING without using up an attempt.
          await AIAnalysis.updateOne({ _id: job._id }, { $set: { status: 'PENDING', nextAttemptAt: new Date(Date.now() + err.delayMs) }, $inc: { attempts: -1 }, $unset: { lockedUntil: 1 } });
          return true;
        }
        final = await failOrRetry(job, err);
      }
    }
    if (final && onJobFinished && !isEvidenceJob(job.analysisType)) {
      await onJobFinished(job.complaint).catch((err) => logger.error({ err: safeError(err) }, 'post-analysis hook failed'));
    }
    return true;
  }

  async function workerLoop() {
    try {
      while (!stopping && (await processOne()));
    } catch (err) {
      logger.error({ err: safeError(err) }, 'analysis worker error');
    }
  }

  let quietRun: Promise<void> | null = null;
  async function quietLoop(deadline: number, maxWaitMs: number) {
    const margin = 5_000;
    try {
      while (!stopping && Date.now() < deadline - margin) {
        // Let workers started during the request finish first.
        while (running.size) await Promise.allSettled([...running]);
        while (!stopping && Date.now() < deadline - margin && (await processOne()));
        const next = await AIAnalysis.findOne({ analysisType: { $in: RUNNABLE_TYPES }, status: 'PENDING' }).sort({ nextAttemptAt: 1 }).select('nextAttemptAt').lean();
        if (!next?.nextAttemptAt) return;
        const wait = next.nextAttemptAt.getTime() - Date.now();
        if (wait > Math.min(maxWaitMs, deadline - margin - Date.now())) return;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    } catch (err) {
      logger.error({ err: safeError(err) }, 'analysis run-until-quiet failed');
    }
  }

  /** Starts workers up to the concurrency limit. Never throws; never blocks the caller. */
  function kick() {
    if (!opts.autoRun || stopping) return;
    while (running.size < concurrency) {
      const p: Promise<void> = workerLoop().finally(() => running.delete(p));
      running.add(p);
    }
  }

  return {
    /** Queues an authenticity check for one stored evidence file. */
    async enqueueMedia(complaintId: Types.ObjectId | string, evidenceId: Types.ObjectId | string, requestedBy?: string) {
      const job = await enqueueOne(complaintId, 'MEDIA_AUTHENTICITY', 'EVIDENCE_ADDED', requestedBy, evidenceId);
      kick();
      return job;
    },
    /** Queues the privacy copy (metadata strip + face/plate blur) for one image. */
    async enqueueRedaction(complaintId: Types.ObjectId | string, evidenceId: Types.ObjectId | string, requestedBy?: string) {
      const job = await enqueueOne(complaintId, 'PRIVACY_REDACTION', 'EVIDENCE_ADDED', requestedBy, evidenceId);
      kick();
      return job;
    },
    /** Queues a before/after comparison for one RESOLUTION evidence file. */
    async enqueueComparison(complaintId: Types.ObjectId | string, evidenceId: Types.ObjectId | string, requestedBy?: string) {
      const job = await enqueueOne(complaintId, 'RESOLUTION_COMPARISON', 'EVIDENCE_ADDED', requestedBy, evidenceId);
      kick();
      return job;
    },
    async enqueue(complaintId: Types.ObjectId | string, types: readonly JobType[], trigger: AnalysisTrigger, requestedBy?: string) {
      const jobs = [];
      for (const type of types) jobs.push(await enqueueOne(complaintId, type, trigger, requestedBy));
      kick();
      return jobs;
    },
    kick,
    setJobFinishedHook(fn: (complaintId: Types.ObjectId) => Promise<unknown>) {
      onJobFinished = fn;
    },
    setEventBus(bus: EventBus) {
      events = bus;
    },
    /**
     * For serverless hosts (Vercel), where nothing runs between requests: processes due jobs until
     * none are left, also waiting for jobs that become due soon (retries, deferred jobs), and stops
     * before `deadline` (epoch ms). Anything left is picked up by the next request or the daily cron.
     * Never throws.
     */
    runUntilQuiet(deadline: number, maxWaitMs = 20_000): Promise<void> {
      // One loop per instance: concurrent requests share it instead of each starting their own.
      quietRun ??= quietLoop(deadline, maxWaitMs).finally(() => {
        quietRun = null;
      });
      return quietRun;
    },
    /** Processes due jobs until none are left (tests and scripts). */
    async drain(maxJobs = 100) {
      for (let i = 0; i < maxJobs && (await processOne()); i++);
    },
    start(intervalMs = 30_000) {
      stopping = false;
      timer = setInterval(() => kick(), intervalMs);
      timer.unref();
      kick();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      await Promise.allSettled([...running]);
    },
  };
}
export type AnalysisRunner = ReturnType<typeof createAnalysisRunner>;
