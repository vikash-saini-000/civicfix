// Schema validation only. No database connection is needed.
import { describe, expect, it } from 'vitest';
import {
  AIAnalysis,
  AuditLog,
  Complaint,
  Department,
  DepartmentMembership,
  Dispute,
  Evidence,
  Feedback,
  Notification,
  User,
  WorkOrder,
} from '../src/models/index.js';
import { invalidPaths, oid, point, validComplaint } from './helpers.js';

describe('User', () => {
  it('requires name, email and password hash', async () => {
    expect(await invalidPaths(new User({}))).toEqual(['email', 'name', 'passwordHash']);
  });

  it('normalizes email and defaults to an active citizen', async () => {
    const u = new User({ name: 'Asha', email: '  Asha@Example.COM ', passwordHash: 'x' });
    expect(await invalidPaths(u)).toEqual([]);
    expect(u.email).toBe('asha@example.com');
    expect(u.platformRole).toBe('CITIZEN');
    expect(u.accountStatus).toBe('ACTIVE');
  });

  it('rejects malformed email and unknown roles', async () => {
    const u = new User({ name: 'A', email: 'not-an-email', passwordHash: 'x', platformRole: 'SUPERUSER' });
    expect(await invalidPaths(u)).toEqual(['email', 'platformRole']);
  });

  it('never serializes the password hash', async () => {
    const u = new User({ name: 'A', email: 'a@b.co', passwordHash: 'secret-hash' });
    expect(JSON.stringify(u)).not.toContain('secret-hash');
  });
});

describe('Department and membership', () => {
  it('requires at least one known, unrepeated category', async () => {
    expect(await invalidPaths(new Department({ name: 'Roads', categories: [] }))).toEqual(['categories']);
    expect(await invalidPaths(new Department({ name: 'Roads', categories: ['roads', 'roads'] }))).toEqual(['categories']);
    expect(await invalidPaths(new Department({ name: 'Roads', categories: ['bridges'] }))).toEqual(['categories.0']);
    expect(await invalidPaths(new Department({ name: 'Roads', categories: ['roads'] }))).toEqual([]);
  });

  it('defaults membership to an active member and rejects unknown roles', async () => {
    const m = new DepartmentMembership({ user: oid(), department: oid() });
    expect(m.role).toBe('MEMBER');
    expect(m.status).toBe('ACTIVE');
    expect(await invalidPaths(new DepartmentMembership({ user: oid(), department: oid(), role: 'ADMIN' }))).toEqual(['role']);
  });
});

describe('Complaint', () => {
  it('accepts a minimal valid report with REPORTED status and optional fields empty', async () => {
    const c = new Complaint(validComplaint());
    expect(await invalidPaths(c)).toEqual([]);
    expect(c.status).toBe('REPORTED');
    expect(c.confirmedCategory).toBeUndefined();
    expect(c.priority).toBeUndefined();
    expect(c.duplicateOf).toBeUndefined();
  });

  it('requires citizen, title, description, location and public ID', async () => {
    expect(await invalidPaths(new Complaint({}))).toEqual(['citizen', 'description', 'location', 'publicId', 'title']);
  });

  it('rejects bad public IDs, coordinates, categories, priorities and statuses', async () => {
    const c = new Complaint({
      ...validComplaint(),
      publicId: '141',
      location: point(200, 13),
      selectedCategory: 'bridges',
      priority: 'P9',
      status: 'DONE',
    });
    expect(await invalidPaths(c)).toEqual(['location.coordinates', 'priority', 'publicId', 'selectedCategory', 'status']);
  });

  it('requires a reason when rejected', async () => {
    expect(await invalidPaths(new Complaint({ ...validComplaint(), status: 'REJECTED' }))).toEqual(['rejectionReason']);
  });

  it('represents a duplicate as a link to the canonical complaint', async () => {
    const canonical = oid();
    const c = new Complaint({
      ...validComplaint(),
      duplicateOf: { complaint: canonical, source: 'SYSTEM_RULE', linkedAt: new Date() },
    });
    expect(await invalidPaths(c)).toEqual([]);
    expect(c.duplicateOf!.complaint!.equals(canonical)).toBe(true);
  });

  it('requires the manager when a duplicate is linked by a manager', async () => {
    const c = new Complaint({ ...validComplaint(), duplicateOf: { complaint: oid(), source: 'MANAGER', linkedAt: new Date() } });
    expect(await invalidPaths(c)).toEqual(['duplicateOf.linkedBy']);
  });

  it('cannot be a duplicate of itself', async () => {
    const c = new Complaint(validComplaint());
    c.duplicateOf = { complaint: c._id, source: 'SYSTEM_RULE', linkedAt: new Date() } as never;
    await expect(c.validate()).rejects.toThrow(/duplicate of itself/);
  });
});

describe('WorkOrder', () => {
  const base = () => ({ complaint: oid(), department: oid(), priority: 'P2' });

  it('starts pending assignment without an assignee', async () => {
    const w = new WorkOrder(base());
    expect(await invalidPaths(w)).toEqual([]);
    expect(w.status).toBe('PENDING_ASSIGNMENT');
  });

  it('requires an assignee once assigned', async () => {
    expect(await invalidPaths(new WorkOrder({ ...base(), status: 'ASSIGNED' }))).toEqual(['assignee']);
    expect(await invalidPaths(new WorkOrder({ ...base(), status: 'ASSIGNED', assignee: oid() }))).toEqual([]);
  });

  it('requires a reason and next action when blocked', async () => {
    const w = new WorkOrder({ ...base(), status: 'BLOCKED', assignee: oid() });
    expect(await invalidPaths(w)).toEqual(['blockedNextAction', 'blockedReason']);
  });

  it('requires at least one reason for a manager review', async () => {
    const w = new WorkOrder({ ...base(), managerReview: { reasons: [], requestedAt: new Date() } });
    expect(await invalidPaths(w)).toEqual(['managerReview.reasons']);
  });
});

describe('AIAnalysis', () => {
  const base = () => ({ complaint: oid(), analysisType: 'TRIAGE', status: 'SUCCEEDED', provider: 'test', modelName: 'm' });

  it('accepts structured triage output', async () => {
    const a = new AIAnalysis({
      ...base(),
      suggestedCategory: 'roads',
      suggestedPriority: 'P2',
      confidence: 0.82,
      duplicateCandidates: [{ complaint: oid(), similarity: 0.9, distanceMeters: 40 }],
      reviewFlags: ['HIGH_URGENCY'],
    });
    expect(await invalidPaths(a)).toEqual([]);
  });

  it('rejects out-of-range confidence and values outside the enums', async () => {
    const a = new AIAnalysis({
      ...base(),
      suggestedCategory: 'aliens',
      confidence: 1.5,
      duplicateCandidates: [{ complaint: oid(), similarity: -1 }],
    });
    expect(await invalidPaths(a)).toEqual(['confidence', 'duplicateCandidates.0.similarity', 'suggestedCategory']);
  });

  it('requires a work order for resolution verification', async () => {
    expect(await invalidPaths(new AIAnalysis({ ...base(), analysisType: 'RESOLUTION_VERIFICATION' }))).toEqual(['workOrder']);
  });
});

describe('Evidence', () => {
  const base = () => ({
    purpose: 'COMPLAINT_REPORT',
    complaint: oid(),
    uploadedBy: oid(),
    mediaType: 'IMAGE',
    contentType: 'image/jpeg',
    sizeBytes: 1000,
    storageProvider: 'local',
    storageKey: 'complaints/abc.jpg',
  });

  it('accepts complaint photo metadata', async () => {
    expect(await invalidPaths(new Evidence(base()))).toEqual([]);
  });

  it('rejects disallowed or mismatched types and oversize files', async () => {
    expect(await invalidPaths(new Evidence({ ...base(), contentType: 'application/pdf' }))).toEqual(['contentType']);
    expect(await invalidPaths(new Evidence({ ...base(), contentType: 'video/mp4' }))).toEqual(['contentType']);
    expect(await invalidPaths(new Evidence({ ...base(), sizeBytes: 11 * 1024 * 1024 }))).toEqual(['sizeBytes']);
  });

  it('links resolution evidence to a work order and dispute evidence to a dispute', async () => {
    expect(await invalidPaths(new Evidence({ ...base(), purpose: 'RESOLUTION' }))).toEqual(['workOrder']);
    expect(await invalidPaths(new Evidence({ ...base(), purpose: 'DISPUTE' }))).toEqual(['dispute']);
  });
});

describe('AuditLog', () => {
  const base = () => ({ actorType: 'USER', actor: oid(), action: 'complaint.created', targetType: 'Complaint', targetId: oid(), outcome: 'SUCCESS' });

  it('accepts a valid entry', async () => {
    expect(await invalidPaths(new AuditLog(base()))).toEqual([]);
  });

  it('requires an actor for user actions but not for system or AI actions', async () => {
    expect(await invalidPaths(new AuditLog({ ...base(), actor: undefined }))).toEqual(['actor']);
    expect(await invalidPaths(new AuditLog({ ...base(), actor: undefined, actorType: 'AI' }))).toEqual([]);
  });

  it('rejects sensitive fields in the change summary and malformed actions', async () => {
    const a = new AuditLog({ ...base(), action: 'Created!', changes: [{ field: 'passwordHash', before: 'a', after: 'b' }] });
    expect(await invalidPaths(a)).toEqual(['action', 'changes.0.field']);
  });
});

describe('Notification, Dispute, Feedback', () => {
  it('requires a notification to reference a related resource', async () => {
    const n = new Notification({ recipient: oid(), type: 'COMPLAINT_STATUS_CHANGED', title: 't', message: 'm' });
    await expect(n.validate()).rejects.toThrow(/must reference/);
    n.complaint = oid();
    await expect(n.validate()).resolves.toBeUndefined();
    expect(n.deliveryStatus).toBe('PENDING');
    expect(n.attempts).toBe(0);
  });

  it('requires a decision record once a dispute is decided', async () => {
    const d = new Dispute({
      complaint: oid(),
      workOrder: oid(),
      submittedBy: oid(),
      reason: 'The pothole is still there after the fix.',
      priorResolution: { resolvedAt: new Date() },
      status: 'UPHELD',
    });
    expect(await invalidPaths(d)).toEqual(['decidedAt', 'decidedBy', 'decisionReason']);
  });

  it('requires the prior resolution snapshot on a dispute', async () => {
    const d = new Dispute({ complaint: oid(), workOrder: oid(), submittedBy: oid(), reason: 'Still broken after repair.' });
    expect(await invalidPaths(d)).toEqual(['priorResolution']);
  });

  it('accepts whole-number ratings from 1 to 5 only', async () => {
    const f = (rating: number) => invalidPaths(new Feedback({ complaint: oid(), citizen: oid(), rating }));
    expect(await f(5)).toEqual([]);
    expect(await f(0)).toEqual(['rating']);
    expect(await f(3.5)).toEqual(['rating']);
  });
});
