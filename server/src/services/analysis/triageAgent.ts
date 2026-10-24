// Triage agent: Claude plans with read-only backend tools, then submits one recommendation.
//
// Safety model
// - Tools are read-only and scoped to this one complaint. They never take or return database IDs:
//   the model sees short refs (D1 department, S1 staff, C1 complaint) that map back only here.
// - No personal data leaves the backend: staff appear as refs with workload counts, never names.
// - Other citizens' report titles appear in tool results as data; the prompt says never to obey them.
// - The output is a recommendation. Refs are re-checked here, and the routing rules in
//   workOrders.evaluateAutoAssignment re-check everything again before anything is committed.
import { Types } from 'mongoose';
import { z } from 'zod';
import { AGENT_PROMPT_VERSION, AGENT_SYSTEM, classifyUserMessage } from '../../ai/prompts.js';
import type { EmbeddingProvider } from '../../ai/embeddings.js';
import { classificationOutputSchema, type AgentStep, type AgentTool, type AiCallMeta, type AiProvider, type ClassificationOutput } from '../../ai/types.js';
import { REVIEW_REASONS, type ReviewReason } from '../../models/enums.js';
import { Complaint, WorkOrder } from '../../models/index.js';
import { OPEN_WORK_ORDER_STATUSES } from '../../policies/workOrderLifecycle.js';
import { availableMembers } from '../staffCapacity.js';
import { findDuplicateCandidates, type DuplicateSettings } from './duplicates.js';

export interface DepartmentOptionWithId {
  ref: string;
  name: string;
  categories: string[];
  id: Types.ObjectId;
}

type TargetComplaint = Parameters<typeof findDuplicateCandidates>[0] & { landmark?: string | null };

export interface TriageAgentOptions {
  maxTurns: number;
  deadlineMs: number;
  maxOpenPerMember: number;
  duplicateSettings: DuplicateSettings;
  embeddings?: EmbeddingProvider;
  /** Location facts (already computed by the runner), returned by get_location_context. */
  locationContext?: Record<string, unknown> | null;
  /** Earlier follow-up questions and answers, passed in the first message. */
  followUp?: { question: string; answer: string }[] | null;
}

/** Reasons the agent may raise through request_human_review. */
const AGENT_REVIEW_REASONS = ['LOW_CONFIDENCE', 'UNCLEAR_DEPARTMENT', 'HIGH_URGENCY', 'MULTI_DEPARTMENT', 'PUBLIC_SAFETY_HAZARD', 'SPAM_SUSPECTED'] as const satisfies readonly ReviewReason[];

export interface TriageAgentResult {
  output: ClassificationOutput;
  meta: AiCallMeta;
  steps: AgentStep[];
  turns: number;
  /** Proposed staff member, already checked to belong to the proposed department. */
  assignee: { user: Types.ObjectId; department: Types.ObjectId } | null;
  likelyDuplicate: Types.ObjectId | null;
  /** Refs the model gave that did not resolve (it guessed or mixed departments). */
  droppedRefs: string[];
  /** Reasons raised with request_human_review during the run. */
  requestedReview: ReviewReason[];
}

const STAFF_REF = /^S\d{1,3}$/;
const COMPLAINT_REF = /^C\d{1,2}$/;
const title = (t: string) => (t.length > 120 ? `${t.slice(0, 117)}...` : t);

export async function runTriageAgent(provider: AiProvider, complaint: TargetComplaint, departments: DepartmentOptionWithId[], opts: TriageAgentOptions): Promise<TriageAgentResult> {
  if (!provider.runAgent) throw new Error('provider does not support agent mode');
  const deptByRef = new Map(departments.map((d) => [d.ref, d]));
  const deptRefs = departments.map((d) => d.ref);
  // Refs handed out during this run only.
  const staffRefs = new Map<string, { user: Types.ObjectId; department: Types.ObjectId }>();
  const complaintRefs = new Map<string, Types.ObjectId>();
  const requestedReview = new Set<ReviewReason>();

  const deptInput = z.strictObject({ departmentRef: deptRefs.length > 0 ? z.enum(deptRefs as [string, ...string[]]) : z.never() });

  const tools: AgentTool[] = [
    {
      name: 'get_location_context',
      description: 'Facts about the reported location: ward, nearby schools, hospitals, main roads and other mapped places with distances in metres, open reports nearby, and duplicates already linked to this report.',
      input: z.strictObject({}),
      async run() {
        return opts.locationContext ?? { ward: null, nearby_places: [], note: 'No location data available.' };
      },
    },
    {
      name: 'request_human_review',
      description: 'Flag this case for a human reviewer with one reason. Always allowed; does not end the run.',
      input: z.strictObject({ reason: z.enum(AGENT_REVIEW_REASONS), note: z.string().max(300).optional() }),
      async run({ reason }: { reason: (typeof AGENT_REVIEW_REASONS)[number] }) {
        if ((REVIEW_REASONS as readonly string[]).includes(reason)) requestedReview.add(reason);
        return { recorded: true, reason };
      },
    },
    {
      name: 'find_similar_complaints',
      description: 'Nearby complaints (within a few hundred metres, filed within two weeks) describing a similar problem. Returns refs C1, C2... with title, category, status, distance and a 0-1 similarity.',
      input: z.strictObject({}),
      async run() {
        const found = await findDuplicateCandidates(complaint, opts.duplicateSettings, opts.embeddings);
        const docs = await Complaint.find({ _id: { $in: found.map((f) => f.complaint) } }).select('title status selectedCategory confirmedCategory').lean();
        const byId = new Map(docs.map((d) => [String(d._id), d]));
        const candidates = found.flatMap((f) => {
          const d = byId.get(String(f.complaint));
          if (!d) return [];
          const ref = `C${complaintRefs.size + 1}`;
          complaintRefs.set(ref, f.complaint);
          return [{ ref, title: title(d.title), category: d.confirmedCategory ?? d.selectedCategory ?? null, status: d.status, distanceMeters: f.distanceMeters, similarity: f.similarity }];
        });
        return { candidates };
      },
    },
    {
      name: 'get_department_workload',
      description: 'Open and overdue work orders for one department, and how many of its staff can take more work.',
      input: deptInput,
      async run({ departmentRef }: { departmentRef: string }) {
        const d = deptByRef.get(departmentRef)!;
        const [open, overdue, available] = await Promise.all([
          WorkOrder.countDocuments({ department: d.id, status: { $in: OPEN_WORK_ORDER_STATUSES } }),
          WorkOrder.countDocuments({ department: d.id, status: { $in: OPEN_WORK_ORDER_STATUSES }, dueAt: { $lt: new Date() } }),
          availableMembers(d.id, opts.maxOpenPerMember),
        ]);
        return { department: d.name, categories: d.categories, openWorkOrders: open, overdueWorkOrders: overdue, staffWithCapacity: available.length };
      },
    },
    {
      name: 'list_available_staff',
      description: 'Staff in one department who can take more work, as refs S1, S2... with their open work-order counts, least busy first. Names are not shared.',
      input: deptInput,
      async run({ departmentRef }: { departmentRef: string }) {
        const d = deptByRef.get(departmentRef)!;
        const available = (await availableMembers(d.id, opts.maxOpenPerMember)).slice(0, 10);
        const staff = available.map((m) => {
          const ref = `S${staffRefs.size + 1}`;
          staffRefs.set(ref, { user: m.user, department: d.id });
          return { ref, openWorkOrders: m.openWorkOrders };
        });
        return { department: d.name, maxOpenPerMember: opts.maxOpenPerMember, staff };
      },
    },
  ];

  const finalSchema = classificationOutputSchema(deptRefs).extend({
    assigneeRef: z.string().regex(STAFF_REF).nullable(),
    likelyDuplicateRef: z.string().regex(COMPLAINT_REF).nullable(),
  });

  const res = await provider.runAgent({
    system: AGENT_SYSTEM,
    userMessage: `${classifyUserMessage({
      title: complaint.title,
      description: complaint.description,
      landmark: complaint.landmark ?? null,
      citizenCategory: complaint.selectedCategory ?? null,
      departments: departments.map(({ ref, name, categories }) => ({ ref, name, categories })),
      locationContext: { note: 'Call get_location_context for details.' },
      followUp: opts.followUp ?? null,
    })}\n\nUse the tools, then call submit_triage.`,
    tools,
    final: {
      name: 'submit_triage',
      description: 'Submit your final triage recommendation. Call exactly once, after using the tools.',
      schema: finalSchema,
    },
    maxTurns: opts.maxTurns,
    deadlineMs: opts.deadlineMs,
    promptVersion: AGENT_PROMPT_VERSION,
  });

  const { assigneeRef, likelyDuplicateRef, ...output } = res.output;
  const dropped: string[] = [];
  // The proposed assignee must have been listed for the department the model finally recommends.
  let assignee = assigneeRef ? (staffRefs.get(assigneeRef) ?? null) : null;
  const dept = output.departmentRef ? deptByRef.get(output.departmentRef) : undefined;
  if (assigneeRef && (!assignee || !dept || !assignee.department.equals(dept.id))) {
    dropped.push(assigneeRef);
    assignee = null;
  }
  const likelyDuplicate = likelyDuplicateRef ? (complaintRefs.get(likelyDuplicateRef) ?? null) : null;
  if (likelyDuplicateRef && !likelyDuplicate) dropped.push(likelyDuplicateRef);

  return { output, meta: res.meta, steps: res.steps, turns: res.turns, assignee, likelyDuplicate, droppedRefs: dropped, requestedReview: [...requestedReview] };
}
