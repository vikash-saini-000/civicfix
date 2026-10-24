// Generates ~150 realistic demo complaints with consistent work orders, AI records, duplicate links,
// feedback and audit entries, spread from January 2025 to today. Deterministic (fixed random seed).
//
// Each complaint walks the real lifecycle with plausible delays (triage minutes, acceptance hours, work
// sized to the priority's target time, sometimes late or blocked) and stops at whatever stage today's
// date allows, so the data is never "in the future". Hotspot groups are planted on purpose:
//   - potholes at three road spots in both the 2025 and 2026 monsoons (recurring, MONSOON pattern)
//   - garbage behind Surathkal fish market all year round (recurring)
//   - streetlights in Kavoor and drains in Kottara (clusters)
// plus a manager review queue with hazards, spam, a category conflict and follow-up questions.
import { Types, type Model } from 'mongoose';
import type { Category, ComplaintStatus, Priority, WorkOrderStatus } from '../../models/enums.js';
import { AIAnalysis, AuditLog, Complaint, Feedback, WorkOrder, nextSequence } from '../../models/index.js';
import { OTHER_TEMPLATES, PLACE_HINTS, REVIEW_CASES, TEMPLATES, type Template } from './complaintTemplates.js';

export interface SeedDepartment {
  _id: Types.ObjectId;
  key: string;
  manager: Types.ObjectId;
  workers: Types.ObjectId[];
}

export interface DemoContext {
  now: Date;
  citizens: Types.ObjectId[];
  wards: { _id: Types.ObjectId; code: string; bounds: [number, number, number, number] }[];
  deptFor: (category: Category, wardCode: string | null) => SeedDepartment;
}

// ---- deterministic randomness ----------------------------------------------------------------
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(2026);
const between = (a: number, b: number) => a + rand() * (b - a);
const int = (a: number, b: number) => Math.floor(between(a, b + 1));
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number) => rand() < p;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DUE_HOURS: Record<Priority, number> = { P1: 24, P2: 72, P3: 168, P4: 336 };

/** Validates through the model (defaults, enums, invariants), then inserts with explicit timestamps. */
async function insertRaw(model: Model<any>, data: Record<string, unknown>, createdAt: Date, updatedAt: Date = createdAt) {
  const doc = new model(data);
  await doc.validate();
  const obj = doc.toObject({ depopulate: true, virtuals: false }) as Record<string, unknown>;
  obj.createdAt = createdAt;
  obj.updatedAt = updatedAt;
  obj.__v = 0;
  await model.collection.insertOne(obj);
  return obj as Record<string, unknown> & { _id: Types.ObjectId };
}

function jitter([lat, lng]: [number, number], meters: number): [number, number] {
  const dLat = (between(-1, 1) * meters) / 111_320;
  const dLng = (between(-1, 1) * meters) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [Math.round((lat + dLat) * 1e6) / 1e6, Math.round((lng + dLng) * 1e6) / 1e6];
}

interface Plan {
  category: Category;
  template: Template;
  at: [number, number];
  createdAt: Date;
  place: string;
  citizen: Types.ObjectId;
  /** Hotspot group; reports within 7 days of the group's open report are linked to it as duplicates. */
  group?: string;
}

const STEPS = ['REPORTED', 'UNDER_REVIEW', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'RESOLUTION_SUBMITTED', 'RESOLVED', 'CLOSED'] as const;
const NOTES: Partial<Record<ComplaintStatus, string>> = {
  UNDER_REVIEW: 'We are checking the details and looking for similar reports nearby.',
  ACCEPTED: 'The assigned team has accepted the work.',
  IN_PROGRESS: 'Work is in progress.',
  BLOCKED: 'Work is paused. The team has recorded the reason and the next step.',
  RESOLUTION_SUBMITTED: 'The team says the work is done and has sent evidence. It is being checked.',
  VERIFICATION_REQUIRED: 'The evidence needs a closer look by a manager before we close this.',
  RESOLVED: 'The fix has been checked and confirmed.',
  CLOSED: 'You confirmed the fix. This complaint is complete.',
};
const WO_FOR: Partial<Record<ComplaintStatus, WorkOrderStatus>> = {
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  IN_PROGRESS: 'IN_PROGRESS',
  BLOCKED: 'BLOCKED',
  RESOLUTION_SUBMITTED: 'RESOLUTION_SUBMITTED',
  VERIFICATION_REQUIRED: 'VERIFICATION_REQUIRED',
  RESOLVED: 'COMPLETED',
  CLOSED: 'COMPLETED',
};
const BLOCKERS = [
  ['Heavy rain; asphalt cannot be laid', 'Resume when the road is dry'],
  ['Waiting for replacement part from the store', 'Collect the part and fit it'],
  ['Traffic police permission needed for the lane closure', 'Get permission and schedule night work'],
  ['Pipe needs a contractor with an excavator', 'Contractor booked for this week'],
];

function plans(ctx: DemoContext): Plan[] {
  const out: Plan[] = [];
  const citizen = () => pick(ctx.citizens);
  const date = (y: number, m: number, d: number, h = int(7, 20)) => new Date(Date.UTC(y, m - 1, d, h - 5, int(0, 59))); // IST-ish daytime

  // 1. Monsoon potholes at three road spots, 2025 and 2026.
  const spots: { name: string; at: [number, number] }[] = [
    { name: 'Kulai junction on NH-66', at: [12.9806, 74.8031] },
    { name: 'the MRPL Road near Katipalla', at: [13.0136, 74.849] },
    { name: 'Panambur Beach Road', at: [12.9418, 74.8001] },
  ];
  for (const s of spots) {
    for (const y of [2025, 2026]) {
      const base = [date(y, 6, int(10, 16)), null, date(y, 7, int(20, 28)), date(y, 8, int(25, 31))];
      base[1] = new Date(base[0]!.getTime() + int(2, 5) * DAY); // a second report a few days later (duplicate)
      for (const d of base) {
        if (d! > ctx.now) continue;
        out.push({ category: 'roads', template: pick(TEMPLATES.roads.slice(0, 5)), at: jitter(s.at, 35), createdAt: d!, place: s.name, citizen: citizen(), group: `pothole:${s.name}:${y}` });
      }
    }
  }
  // 2. Garbage behind the fish market, all year round.
  for (const [y, m] of [[2025, 2], [2025, 4], [2025, 6], [2025, 8], [2025, 10], [2025, 12], [2026, 2], [2026, 5], [2026, 7], [2026, 9]] as const) {
    const d = date(y, m, int(3, 25));
    if (d > ctx.now) continue;
    out.push({ category: 'garbage', template: pick(TEMPLATES.garbage), at: jitter([13.005, 74.7949], 40), createdAt: d, place: 'Surathkal fish market', citizen: citizen(), group: `garbage:fish-market:${y}-${m}` });
  }
  // 3. Streetlights in Kavoor (one duplicate pair).
  for (const [m, d] of [[3, 8], [3, 11], [5, 19], [7, 2], [8, 27], [10, 6]] as const) {
    out.push({ category: 'streetlight', template: pick(TEMPLATES.streetlight), at: jitter([12.931, 74.8575], 60), createdAt: date(2026, m, d), place: 'Kavoor temple road', citizen: citizen(), group: `light:kavoor:${m}` });
  }
  // 4. Drains in Kottara before/during both monsoons.
  for (const [y, m, d] of [[2025, 6, 5], [2025, 6, 9], [2025, 7, 14], [2026, 6, 3], [2026, 6, 6], [2026, 7, 21], [2026, 8, 18]] as const) {
    out.push({ category: 'drainage', template: pick(TEMPLATES.drainage), at: jitter([12.899, 74.832], 40), createdAt: date(y, m, d), place: 'Kottara Chowki', citizen: citizen(), group: `drain:kottara:${y}-${m}` });
  }
  // 5. Everything else, across all wards; more in the last two months.
  const weights: [Category, number][] = [['roads', 0.3], ['garbage', 0.2], ['streetlight', 0.15], ['water', 0.15], ['drainage', 0.12], ['other', 0.08]];
  const start = date(2025, 1, 5).getTime();
  for (let i = 0; i < 95; i++) {
    let r = rand();
    const category = weights.find(([, w]) => (r -= w) < 0)?.[0] ?? 'roads';
    const ward = pick(ctx.wards);
    const [s, w, n, e] = ward.bounds;
    const at: [number, number] = [Math.round(between(s + 0.003, n - 0.003) * 1e6) / 1e6, Math.round(between(w + 0.003, e - 0.003) * 1e6) / 1e6];
    const recent = chance(0.3);
    const t = recent ? between(ctx.now.getTime() - 60 * DAY, ctx.now.getTime() - 2 * HOUR) : between(start, ctx.now.getTime() - 60 * DAY);
    const template = category === 'other' ? pick(OTHER_TEMPLATES) : pick(TEMPLATES[category]);
    out.push({ category, template, at, createdAt: new Date(t), place: pick(PLACE_HINTS), citizen: citizen() });
  }
  return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export async function seedDemoComplaints(ctx: DemoContext): Promise<{ complaints: number; workOrders: number; duplicates: number; reviewQueue: number }> {
  const now = ctx.now;
  const wardOf = (at: [number, number]) => ctx.wards.find((w) => at[0] >= w.bounds[0] && at[0] < w.bounds[2] && at[1] >= w.bounds[1] && at[1] < w.bounds[3]) ?? null;
  const canonicalOf = new Map<string, { id: Types.ObjectId; createdAt: Date; publicId: string; status: ComplaintStatus; closedAt?: Date; manager: Types.ObjectId }>();
  let complaints = 0;
  let workOrders = 0;
  let duplicates = 0;

  for (const p of plans(ctx)) {
    const ward = wardOf(p.at);
    const dept = ctx.deptFor(p.category, ward?.code ?? null);
    const year = p.createdAt.getUTCFullYear();
    const publicId = `CF-${year}-${String(await nextSequence(`complaint-${year}`)).padStart(5, '0')}`;
    const fill = (s: string) => s.replaceAll('{place}', p.place);
    const id = new Types.ObjectId();
    const t0 = p.createdAt;
    const tReview = new Date(t0.getTime() + int(1, 10) * 60_000);

    // Duplicate of the group's open report (filed within 7 days of it)?
    const canonical = p.group ? canonicalOf.get(p.group.split(':').slice(0, 2).join(':')) : undefined;
    const isDuplicate = !!canonical && t0.getTime() - canonical.createdAt.getTime() < 7 * DAY;
    const history: { status: ComplaintStatus; at: Date; publicNote?: string }[] = [{ status: 'REPORTED', at: t0 }, { status: 'UNDER_REVIEW', at: tReview, publicNote: NOTES.UNDER_REVIEW }];
    const triageBase = {
      complaint: id,
      analysisType: 'TRIAGE',
      status: 'SUCCEEDED',
      analysisVersion: 1,
      trigger: 'COMPLAINT_CREATED',
      attempts: 1,
      startedAt: t0,
      completedAt: tReview,
      provider: 'seed-data',
      modelName: 'simulated',
      promptVersion: 'classify-v2',
      latencyMs: int(2500, 9000),
      suggestedCategory: p.category,
      suggestedPriority: p.template.priority,
      modelPriority: p.template.priority,
      suggestedDepartment: dept._id,
      summary: fill(p.template.summary),
      rationale: `Reported problem matches ${p.category}; ${dept.key.startsWith('roads') ? 'the zone department for this ward' : 'the responsible department'} handles it.`,
      certainty: 'HIGH',
      selfReportedConfidence: Math.round(between(0.78, 0.97) * 100) / 100,
      publicSafetyHazard: false,
      spamLikely: false,
      reviewFlags: isDuplicate ? ['AMBIGUOUS_DUPLICATE'] : [],
      reviewRecommended: isDuplicate,
    };

    if (isDuplicate) {
      // Linked by the department manager; stays in triage and closes with the original.
      const linkedAt = new Date(tReview.getTime() + int(1, 6) * HOUR);
      const closedWith = canonical!.closedAt && canonical!.closedAt > linkedAt && canonical!.closedAt <= now ? canonical!.closedAt : undefined;
      history.push({ status: 'UNDER_REVIEW', at: linkedAt, publicNote: `Linked to ${canonical!.publicId}, an earlier report of the same problem. You'll see its progress here.` });
      if (closedWith) history.push({ status: 'CLOSED', at: closedWith, publicNote: `Closed together with ${canonical!.publicId}, the report this one was linked to. The problem was fixed there.` });
      await insertRaw(
        Complaint,
        {
          _id: id,
          publicId,
          citizen: p.citizen,
          title: p.template.title,
          description: fill(p.template.description),
          location: { type: 'Point', coordinates: [p.at[1], p.at[0]] },
          ward: ward?._id,
          selectedCategory: p.category,
          status: closedWith ? 'CLOSED' : 'UNDER_REVIEW',
          statusHistory: history,
          duplicateOf: { complaint: canonical!.id, source: 'MANAGER', linkedBy: canonical!.manager, linkedAt, reason: 'Same spot and problem as the earlier report.' },
          spamCheck: { score: 0, signals: [], checkedAt: t0 },
          closedAt: closedWith,
        },
        t0,
        closedWith ?? linkedAt,
      );
      await Complaint.updateOne({ _id: canonical!.id }, { $inc: { linkedReportCount: 1 } });
      await insertRaw(AIAnalysis, triageBase, t0, tReview);
      await insertRaw(AIAnalysis, { complaint: id, analysisType: 'DUPLICATE_CANDIDATES', status: 'SUCCEEDED', analysisVersion: 1, trigger: 'COMPLAINT_CREATED', attempts: 1, completedAt: tReview, provider: 'civicfix-rules', modelName: 'geo-semantic-v2/text-embedding-3-small', duplicateCandidates: [{ complaint: canonical!.id, similarity: 0.86, distanceMeters: int(10, 60), reason: 'Close by, filed a few days apart, describes the same kind of problem.' }], reviewFlags: ['AMBIGUOUS_DUPLICATE'], reviewRecommended: true }, t0, tReview);
      await insertRaw(AuditLog, { actorType: 'USER', actor: canonical!.manager, action: 'complaint.duplicate_linked', targetType: 'Complaint', targetId: id, outcome: 'SUCCESS', reason: 'Same spot and problem as the earlier report.', changes: [{ field: 'duplicateOf', after: canonical!.publicId }] }, linkedAt);
      complaints++;
      duplicates++;
      continue;
    }

    // ---- full lifecycle ----
    const age = now.getTime() - t0.getTime();
    const auto = chance(0.72);
    const tAssign = new Date(tReview.getTime() + (auto ? int(1, 5) * 60_000 : between(2, 30) * HOUR));
    const tAccept = new Date(tAssign.getTime() + between(1, 10) * HOUR);
    const tStart = new Date(tAccept.getTime() + between(1, 20) * HOUR);
    const due = DUE_HOURS[p.template.priority];
    const blockedInterlude = chance(0.15);
    const work = due * between(0.2, 1.45) * HOUR + (blockedInterlude ? between(10, 48) * HOUR : 0);
    const tBlock = new Date(tStart.getTime() + work * 0.3);
    const tResume = new Date(tBlock.getTime() + Math.min(between(10, 48) * HOUR, work * 0.6));
    const tSubmit = new Date(tStart.getTime() + work);
    const needsCheck = chance(0.3);
    const tCheck = new Date(tSubmit.getTime() + 60_000);
    const tResolved = new Date(tSubmit.getTime() + between(2, 30) * HOUR);
    const citizenCloses = chance(0.75);
    const tClosed = new Date(tResolved.getTime() + between(1, 6) * DAY);

    // How far this one gets: old ones mostly finish; a few get stuck (overdue); some are rejected in triage.
    const rejected = p.category === 'other' ? chance(0.35) : chance(0.02);
    let cap: number = STEPS.length - 1;
    if (!citizenCloses) cap = STEPS.indexOf('RESOLVED');
    if (age > 45 * DAY && chance(0.07)) cap = STEPS.indexOf('IN_PROGRESS');
    else if (age <= 45 * DAY && chance(age <= 10 * DAY ? 0.8 : 0.45)) cap = int(STEPS.indexOf('ASSIGNED'), STEPS.indexOf('RESOLUTION_SUBMITTED'));
    const stepTime: Record<string, Date> = { REPORTED: t0, UNDER_REVIEW: tReview, ASSIGNED: tAssign, ACCEPTED: tAccept, IN_PROGRESS: tStart, RESOLUTION_SUBMITTED: tSubmit, RESOLVED: tResolved, CLOSED: tClosed };
    let reached = 1;
    for (let i = 2; i <= cap; i++) if (stepTime[STEPS[i]!]! <= now) reached = i;

    let status: ComplaintStatus = STEPS[reached]!;
    if (rejected) {
      const tReject = new Date(tReview.getTime() + between(2, 40) * HOUR);
      if (tReject <= now) {
        history.push({ status: 'REJECTED', at: tReject, publicNote: 'This is not something the city corporation handles. Please contact the local police station or the private owner.' });
        status = 'REJECTED';
      } else status = 'UNDER_REVIEW';
    } else {
      for (let i = 2; i <= reached; i++) {
        const s = STEPS[i]!;
        if (s === 'ASSIGNED') history.push({ status: s, at: tAssign, publicNote: `Assigned to ${dept.key.startsWith('roads') ? 'the roads team' : 'the department team'}.` });
        else if (s === 'IN_PROGRESS') {
          history.push({ status: s, at: tStart, publicNote: NOTES.IN_PROGRESS });
          if (blockedInterlude && tBlock <= now && (reached > i || tResume <= now)) {
            history.push({ status: 'BLOCKED', at: tBlock, publicNote: NOTES.BLOCKED });
            if (tResume <= now) history.push({ status: 'IN_PROGRESS', at: tResume, publicNote: 'Work has resumed.' });
          }
        } else if (s === 'RESOLUTION_SUBMITTED') {
          history.push({ status: s, at: tSubmit, publicNote: NOTES.RESOLUTION_SUBMITTED });
          if (needsCheck) history.push({ status: 'VERIFICATION_REQUIRED', at: tCheck, publicNote: NOTES.VERIFICATION_REQUIRED });
        } else history.push({ status: s, at: stepTime[s]!, publicNote: NOTES[s] });
      }
      status = history.at(-1)!.status;
      // A stuck job that sits in progress may be blocked.
      if (status === 'IN_PROGRESS' && cap === STEPS.indexOf('IN_PROGRESS') && chance(0.4)) {
        const at = new Date(Math.min(now.getTime() - HOUR, tStart.getTime() + between(5, 60) * HOUR));
        if (at > tStart) {
          history.push({ status: 'BLOCKED', at, publicNote: NOTES.BLOCKED });
          status = 'BLOCKED';
        }
      }
    }

    const resolvedAt = ['RESOLVED', 'CLOSED'].includes(status) ? tResolved : undefined;
    const closedAt = status === 'CLOSED' ? tClosed : undefined;
    const lastAt = history.at(-1)!.at;
    const routed = !['REPORTED', 'UNDER_REVIEW', 'REJECTED'].includes(status);
    await insertRaw(
      Complaint,
      {
        _id: id,
        publicId,
        citizen: p.citizen,
        title: p.template.title,
        description: fill(p.template.description),
        location: { type: 'Point', coordinates: [p.at[1], p.at[0]] },
        ward: ward?._id,
        selectedCategory: chance(0.85) ? p.category : undefined,
        ...(routed && { confirmedCategory: p.category, department: dept._id, priority: p.template.priority }),
        status,
        statusHistory: history,
        rejectionReason: status === 'REJECTED' ? history.at(-1)!.publicNote : undefined,
        spamCheck: { score: 0, signals: [], checkedAt: t0 },
        resolvedAt,
        closedAt,
      },
      t0,
      lastAt,
    );
    await insertRaw(AIAnalysis, triageBase, t0, tReview);
    await insertRaw(AIAnalysis, { complaint: id, analysisType: 'DUPLICATE_CANDIDATES', status: 'SUCCEEDED', analysisVersion: 1, trigger: 'COMPLAINT_CREATED', attempts: 1, completedAt: tReview, provider: 'civicfix-rules', modelName: 'geo-semantic-v2/text-embedding-3-small', duplicateCandidates: [], reviewFlags: [], reviewRecommended: false }, t0, tReview);
    await insertRaw(AuditLog, { actorType: 'USER', actor: p.citizen, action: 'complaint.created', targetType: 'Complaint', targetId: id, outcome: 'SUCCESS', changes: [{ field: 'publicId', after: publicId }] }, t0);
    complaints++;
    if (p.group) {
      const key = p.group.split(':').slice(0, 2).join(':');
      const prev = canonicalOf.get(key);
      if (!prev || t0.getTime() - prev.createdAt.getTime() >= 7 * DAY) canonicalOf.set(key, { id, createdAt: t0, publicId, status, closedAt, manager: dept.manager });
    }

    if (!routed) continue;
    // ---- work order ----
    const woStatus = WO_FOR[status]!;
    const assignee = pick(dept.workers);
    const woYear = tAssign.getUTCFullYear();
    const woPublicId = `WO-${woYear}-${String(await nextSequence(`workorder-${woYear}`)).padStart(5, '0')}`;
    const dueAt = new Date(tAssign.getTime() + due * HOUR);
    const woHistory: Record<string, unknown>[] = [
      { at: tAssign, action: 'created', actorType: auto ? 'SYSTEM' : 'USER', actor: auto ? undefined : dept.manager, toStatus: 'PENDING_ASSIGNMENT', department: dept._id, policyVersion: 'assign-v1' },
      { at: tAssign, action: 'assign_staff', actorType: auto ? 'SYSTEM' : 'USER', actor: auto ? undefined : dept.manager, fromStatus: 'PENDING_ASSIGNMENT', toStatus: 'ASSIGNED', department: dept._id, assignee, policyVersion: 'assign-v1' },
    ];
    const step = (at: Date, action: string, from: WorkOrderStatus, to: WorkOrderStatus, actor = assignee, reason?: string) => woHistory.push({ at, action, actorType: 'USER', actor, fromStatus: from, toStatus: to, reason });
    const seen = history.map((h) => h.status);
    if (seen.includes('ACCEPTED')) step(tAccept, 'accept', 'ASSIGNED', 'ACCEPTED');
    if (seen.includes('IN_PROGRESS')) step(tStart, 'start', 'ACCEPTED', 'IN_PROGRESS');
    const blockedIdx = seen.indexOf('BLOCKED');
    const blocker = pick(BLOCKERS);
    if (blockedIdx >= 0) {
      step(history[blockedIdx]!.at, 'block', 'IN_PROGRESS', 'BLOCKED', assignee, blocker[0]);
      if (seen.lastIndexOf('IN_PROGRESS') > blockedIdx) step(history[seen.lastIndexOf('IN_PROGRESS')]!.at, 'start', 'BLOCKED', 'IN_PROGRESS');
    }
    if (seen.includes('RESOLUTION_SUBMITTED')) step(tSubmit, 'submit_resolution', 'IN_PROGRESS', 'RESOLUTION_SUBMITTED');
    if (seen.includes('VERIFICATION_REQUIRED')) woHistory.push({ at: tCheck, action: 'require_verification', actorType: 'SYSTEM', fromStatus: 'RESOLUTION_SUBMITTED', toStatus: 'VERIFICATION_REQUIRED', reason: 'A photo needs a closer look.' });
    if (resolvedAt) step(resolvedAt, 'approve', seen.includes('VERIFICATION_REQUIRED') ? 'VERIFICATION_REQUIRED' : 'RESOLUTION_SUBMITTED', 'COMPLETED', dept.manager, 'Photos match the location and show the fix.');
    const completedAt = woStatus === 'COMPLETED' ? resolvedAt : undefined;
    await insertRaw(
      WorkOrder,
      {
        publicId: woPublicId,
        complaint: id,
        activeFor: woStatus === 'COMPLETED' ? undefined : id,
        department: dept._id,
        priority: p.template.priority,
        status: woStatus,
        assignee,
        assignedBy: auto ? undefined : dept.manager,
        assignmentSource: auto ? 'AUTO' : 'MANAGER',
        assignmentReason: auto
          ? 'Automatic routing (assign-v1): high-certainty classification, single department serving this location, no duplicates or safety flags.'
          : 'Checked the report; routed to the team that covers this area.',
        assignedAt: tAssign,
        dueAt,
        slaBreachedAt: completedAt && completedAt > dueAt ? new Date(dueAt.getTime() + 5 * 60_000) : undefined,
        acceptedAt: seen.includes('ACCEPTED') ? tAccept : undefined,
        startedAt: seen.includes('IN_PROGRESS') ? tStart : undefined,
        ...(status === 'BLOCKED' && { blockedReason: blocker[0], blockedNextAction: blocker[1], blockedAt: history.at(-1)!.at }),
        ...(seen.includes('RESOLUTION_SUBMITTED') && { completionNotes: 'Work completed; before and after photos attached.', resolutionSubmittedAt: tSubmit }),
        ...(completedAt && { completedAt, verificationDecision: { decision: 'APPROVED', source: 'VERIFIER', decidedBy: dept.manager, decidedAt: completedAt, reason: 'Photos match the location and show the fix.' } }),
        history: woHistory,
      },
      tAssign,
      lastAt,
    );
    workOrders++;
    await insertRaw(AuditLog, { actorType: auto ? 'SYSTEM' : 'USER', actor: auto ? undefined : dept.manager, action: 'assignment.decided', targetType: 'Complaint', targetId: id, outcome: 'SUCCESS', changes: [{ field: 'source', after: auto ? 'AUTO' : 'MANAGER' }, { field: 'workOrder', after: woPublicId }] }, tAssign);
    if (closedAt && chance(0.7)) {
      const rating = pick([5, 5, 4, 4, 4, 3, 2]);
      await insertRaw(Feedback, { complaint: id, citizen: p.citizen, rating, comment: rating >= 4 ? pick(['Fixed quickly, thank you.', 'Good work by the team.', 'Took some time but done properly.']) : pick(['Took too long.', 'Fixed, but the patch is uneven.']) }, new Date(closedAt.getTime() + HOUR));
    }
  }

  // ---- manager review queue: recent cases that need a human ----
  let reviewQueue = 0;
  for (const [i, r] of REVIEW_CASES.entries()) {
    const ward = wardOf(r.near);
    const dept = ctx.deptFor(r.category, ward?.code ?? null);
    const t0 = new Date(now.getTime() - (i * 4 + 2) * HOUR);
    const tReview = new Date(t0.getTime() + int(1, 6) * 60_000);
    const year = t0.getUTCFullYear();
    const publicId = `CF-${year}-${String(await nextSequence(`complaint-${year}`)).padStart(5, '0')}`;
    const id = new Types.ObjectId();
    const suggested = r.reasons.includes('UNCLEAR_DEPARTMENT') ? undefined : dept._id;
    await insertRaw(
      Complaint,
      {
        _id: id,
        publicId,
        citizen: pick(ctx.citizens),
        title: r.title,
        description: r.description,
        location: { type: 'Point', coordinates: [r.near[1], r.near[0]] },
        ward: ward?._id,
        selectedCategory: r.citizenCategory ?? (r.category === 'other' ? undefined : r.category),
        status: 'UNDER_REVIEW',
        statusHistory: [{ status: 'REPORTED', at: t0 }, { status: 'UNDER_REVIEW', at: tReview, publicNote: NOTES.UNDER_REVIEW }],
        routingReview: { reasons: r.reasons, suggestedDepartment: suggested, evaluatedAt: tReview, policyVersion: 'assign-v1' },
        spamCheck: { score: r.spam?.score ?? 0, signals: r.spam?.signals ?? [], checkedAt: t0 },
        ...(r.followUp && { followUp: { questions: r.followUp, askedAt: tReview, answers: [] } }),
      },
      t0,
      tReview,
    );
    await insertRaw(
      AIAnalysis,
      {
        complaint: id,
        analysisType: 'TRIAGE',
        status: 'SUCCEEDED',
        analysisVersion: 1,
        trigger: 'COMPLAINT_CREATED',
        attempts: 1,
        completedAt: tReview,
        provider: 'seed-data',
        modelName: 'simulated',
        promptVersion: 'classify-v2',
        suggestedCategory: r.category,
        suggestedPriority: r.priority,
        modelPriority: r.priority,
        suggestedDepartment: suggested,
        summary: r.summary,
        rationale: 'Needs a human decision; see review reasons.',
        certainty: r.certainty,
        selfReportedConfidence: r.confidence,
        publicSafetyHazard: !!r.hazard,
        spamLikely: !!r.spam,
        followUpQuestions: r.followUp ?? [],
        missingInformation: r.followUp ? ['exact problem', 'nearest landmark'] : [],
        reviewFlags: r.reasons,
        reviewRecommended: true,
      },
      t0,
      tReview,
    );
    await insertRaw(AIAnalysis, { complaint: id, analysisType: 'DUPLICATE_CANDIDATES', status: 'SUCCEEDED', analysisVersion: 1, trigger: 'COMPLAINT_CREATED', attempts: 1, completedAt: tReview, provider: 'civicfix-rules', modelName: 'geo-semantic-v2/text-embedding-3-small', duplicateCandidates: [], reviewFlags: r.reasons.includes('AMBIGUOUS_DUPLICATE') ? ['AMBIGUOUS_DUPLICATE'] : [], reviewRecommended: r.reasons.includes('AMBIGUOUS_DUPLICATE') }, t0, tReview);
    complaints++;
    reviewQueue++;
  }
  return { complaints, workOrders, duplicates, reviewQueue };
}
