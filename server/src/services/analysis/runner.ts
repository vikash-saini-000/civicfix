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
import { DEFAULT_DUPLICATE_SETTINGS, DUPLICATE_METHOD, findDuplicateCandidates, type DuplicateSettings } from './duplicates.js';

export const JOB_TYPES = ['TRIAGE', 'DUPLICATE_CANDIDATES'] as const;
export type JobType = (typeof JOB_TYPES)[number];
/** Everything the runner processes, including per-evidence media checks. */
const RUNNABLE_TYPES = [...JOB_TYPES, 'MEDIA_AUTHENTICITY'] as const;

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
}

const activeKey = (complaint: Types.ObjectId | string, type: string, evidence?: Types.ObjectId | string | null) =>
  `${String(complaint)}:${type}:${evidence ? String(evidence) : '-'}`;

const isDuplicateKey = (err: unknown) => (err as { code?: number }).code === 11000;

export function createAnalysisRunner(opts: RunnerOptions) {
  const { provider, logger } = opts;
  const concurrency = opts.concurrency ?? 2;
  const leaseMs = opts.leaseMs ?? Math.max(60_000, 3 * 30_000);
  const retryBaseMs = opts.retryBaseMs ?? 2_000;
  const dupSettings = opts.duplicateSettings ?? DEFAULT_DUPLICATE_SETTINGS;
  const maxDepartments = opts.maxDepartmentsInPrompt ?? 50;

  const running = new Set<Promise<void>>();
  let timer: NodeJS.Timeout | undefined;
  // Called after a TRIAGE or DUPLICATE_CANDIDATES job reaches a final state (e.g. automatic assignment).
  let onJobFinished: ((complaintId: Types.ObjectId) => Promise<unknown>) | null = null;
  let events: EventBus | null = null;
  let stopping = false;

  /** Creates a PENDING job, or returns the one already active for the same complaint + type. */
  async function enqueueOne(
    complaintId: Types.ObjectId | string,
    type: JobType | 'MEDIA_AUTHENTICITY',
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
          modelName: type === 'DUPLICATE_CANDIDATES' ? DUPLICATE_METHOD.modelName : provider.model,
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
    logger[level]({ analysisId: String(job._id), type: job.analysisType, attempts: job.attempts, errorCode: code, err: providerErr ? undefined : safeError(err) }, 'analysis failed');
    return true;
  }

  async function runTriage(job: { _id: Types.ObjectId; complaint: Types.ObjectId }) {
    const complaint = await Complaint.findById(job.complaint).select('title description landmark selectedCategory status').lean();
    if (!complaint) {
      await finish(job._id, { status: 'FAILED', errorCode: 'COMPLAINT_NOT_FOUND' });
      return;
    }
    const departments = await Department.find({ isActive: true }).sort({ name: 1 }).limit(maxDepartments).select('name categories').lean();
    const options = departments.map((d, i) => ({ ref: `D${i + 1}`, name: d.name, categories: [...d.categories], id: d._id }));

    const { output, meta } = await provider.classifyComplaint({
      title: complaint.title,
      description: complaint.description,
      landmark: complaint.landmark ?? null,
      citizenCategory: complaint.selectedCategory ?? null,
      departments: options.map(({ ref, name, categories }) => ({ ref, name, categories })),
    });

    // The model may only point at an offered department, and it must handle the suggested category.
    const flags = new Set(output.reviewReasons);
    let department = options.find((o) => o.ref === output.departmentRef) ?? null;
    if (department && !department.categories.includes(output.category)) {
      department = null;
      flags.add('UNCLEAR_DEPARTMENT');
    }
    if (!department) flags.add('UNCLEAR_DEPARTMENT');
    if (output.certainty === 'LOW') flags.add('LOW_CONFIDENCE');
    if (output.priority === 'P1') flags.add('HIGH_URGENCY');

    await finish(job._id, {
      status: 'SUCCEEDED',
      errorCode: null,
      provider: meta.provider,
      modelName: meta.model,
      promptVersion: meta.promptVersion,
      latencyMs: meta.latencyMs,
      usage: { inputTokens: meta.inputTokens, outputTokens: meta.outputTokens },
      suggestedCategory: output.category as Category,
      suggestedPriority: output.priority,
      suggestedDepartment: department?.id ?? null,
      summary: output.summary,
      rationale: output.rationale,
      missingInformation: output.missingInformation,
      certainty: output.certainty,
      reviewFlags: [...flags],
      reviewRecommended: output.reviewRecommended || flags.size > 0,
    });

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

  async function runDuplicates(job: { _id: Types.ObjectId; complaint: Types.ObjectId }) {
    const complaint = await Complaint.findById(job.complaint).select('title description location createdAt selectedCategory confirmedCategory').lean();
    if (!complaint) {
      await finish(job._id, { status: 'FAILED', errorCode: 'COMPLAINT_NOT_FOUND' });
      return;
    }
    const started = Date.now();
    const candidates = await findDuplicateCandidates(complaint as never, dupSettings);
    await finish(job._id, {
      status: 'SUCCEEDED',
      errorCode: null,
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
    const result = await analyzeMedia(bytes, ev.contentType, { complaintTitle: complaint?.title ?? '', complaintDescription: complaint?.description ?? '' }, provider);
    await finish(job._id, { status: 'SUCCEEDED', ...mediaRecordFields(result) });
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
        else await runDuplicates(job);
        logger.info({ analysisId: String(job._id), type: job.analysisType, attempt: job.attempts }, 'analysis completed');
      } catch (err) {
        final = await failOrRetry(job, err);
      }
    }
    if (final && onJobFinished && job.analysisType !== 'MEDIA_AUTHENTICITY') {
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
