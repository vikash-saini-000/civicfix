// Index, uniqueness and timestamp behaviour against a throwaway in-memory MongoDB.
// Uses the locally installed mongod when MONGOMS_SYSTEM_BINARY is set; otherwise
// mongodb-memory-server downloads one on first run.
import mongoose from 'mongoose';
import { testMongo } from './mongo.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as models from '../src/models/index.js';
import { AuditLog, Complaint, Department, DepartmentMembership, Feedback, Notification, User } from '../src/models/index.js';
import { oid, point, validComplaint } from './helpers.js';

let mongo: Awaited<ReturnType<typeof testMongo>>;

beforeAll(async () => {
  mongo = await testMongo();
  await mongoose.connect(mongo.getUri(), { dbName: 'civicfix-test' });
  const all = Object.values(models).filter((m): m is mongoose.Model<any> => typeof m === 'function' && 'syncIndexes' in m);
  await Promise.all(all.map((m) => m.syncIndexes()));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

const isDuplicateKey = (e: unknown) => (e as { code?: number }).code === 11000;

describe('uniqueness', () => {
  it('rejects a second user with the same email in different case', async () => {
    await User.create({ name: 'A', email: 'dup@example.com', passwordHash: 'h' });
    const err = await User.create({ name: 'B', email: 'DUP@example.com', passwordHash: 'h' }).catch((e) => e);
    expect(isDuplicateKey(err)).toBe(true);
  });

  it('rejects department names that differ only in case', async () => {
    await Department.create({ name: 'Roads and Public Works', categories: ['roads'] });
    const err = await Department.create({ name: 'roads and public works', categories: ['roads'] }).catch((e) => e);
    expect(isDuplicateKey(err)).toBe(true);
  });

  it('rejects a duplicate membership but allows the same user in another department', async () => {
    const user = oid();
    const dept = oid();
    await DepartmentMembership.create({ user, department: dept });
    const err = await DepartmentMembership.create({ user, department: dept, role: 'MANAGER' }).catch((e) => e);
    expect(isDuplicateKey(err)).toBe(true);
    await expect(DepartmentMembership.create({ user, department: oid() })).resolves.toBeTruthy();
  });

  it('rejects a duplicate complaint public ID', async () => {
    await Complaint.create({ ...validComplaint(), publicId: 'CF-2026-90001' });
    const err = await Complaint.create({ ...validComplaint(), publicId: 'CF-2026-90001' }).catch((e) => e);
    expect(isDuplicateKey(err)).toBe(true);
  });

  it('allows one feedback per citizen per complaint', async () => {
    const complaint = oid();
    const citizen = oid();
    await Feedback.create({ complaint, citizen, rating: 4 });
    const err = await Feedback.create({ complaint, citizen, rating: 2 }).catch((e) => e);
    expect(isDuplicateKey(err)).toBe(true);
  });

  it('deduplicates notifications by key but allows many without a key', async () => {
    const base = { recipient: oid(), complaint: oid(), type: 'COMPLAINT_STATUS_CHANGED' as const, title: 't', message: 'm' };
    await Notification.create({ ...base, dedupeKey: 'k1' });
    expect(isDuplicateKey(await Notification.create({ ...base, dedupeKey: 'k1' }).catch((e) => e))).toBe(true);
    await Notification.create(base);
    await expect(Notification.create(base)).resolves.toBeTruthy();
  });
});

describe('complaints', () => {
  it('sets timestamps and keeps the original when linked as a duplicate', async () => {
    const canonical = await Complaint.create({ ...validComplaint(), publicId: 'CF-2026-90010' });
    const dup = await Complaint.create({
      ...validComplaint(),
      publicId: 'CF-2026-90011',
      duplicateOf: { complaint: canonical._id, source: 'SYSTEM_RULE', linkedAt: new Date() },
    });
    expect(dup.createdAt).toBeInstanceOf(Date);
    expect(dup.updatedAt).toBeInstanceOf(Date);

    const linked = await Complaint.find({ 'duplicateOf.complaint': canonical._id });
    expect(linked.map((c) => c.publicId)).toEqual(['CF-2026-90011']);
    expect(await Complaint.exists({ _id: canonical._id })).toBeTruthy();
  });

  it('finds nearby complaints through the 2dsphere index', async () => {
    await Complaint.create({ ...validComplaint(), publicId: 'CF-2026-90020', location: point(74.8, 13.0) });
    await Complaint.create({ ...validComplaint(), publicId: 'CF-2026-90021', location: point(75.5, 13.0) }); // ~75 km away
    const near = await Complaint.find({
      publicId: { $in: ['CF-2026-90020', 'CF-2026-90021'] },
      location: { $nearSphere: { $geometry: point(74.8005, 13.0), $maxDistance: 100 } },
    });
    expect(near.map((c) => c.publicId)).toEqual(['CF-2026-90020']);
  });

  it('does not allow the citizen or public ID to change', async () => {
    const c = await Complaint.create({ ...validComplaint(), publicId: 'CF-2026-90030' });
    const original = c.citizen;
    c.citizen = oid();
    c.publicId = 'CF-2026-99999';
    await c.save();
    const fresh = await Complaint.findById(c._id).orFail();
    expect(fresh.citizen.equals(original)).toBe(true);
    expect(fresh.publicId).toBe('CF-2026-90030');
  });
});

describe('audit log', () => {
  it('can be written but not updated or deleted', async () => {
    const entry = await AuditLog.create({ actorType: 'SYSTEM', action: 'complaint.created', targetType: 'Complaint', targetId: oid(), outcome: 'SUCCESS' });
    expect(entry.createdAt).toBeInstanceOf(Date);
    expect((entry as unknown as { updatedAt?: Date }).updatedAt).toBeUndefined();

    await expect(AuditLog.updateOne({ _id: entry._id }, { reason: 'edited' })).rejects.toThrow(/append-only/);
    await expect(AuditLog.deleteOne({ _id: entry._id })).rejects.toThrow(/append-only/);
    await expect(AuditLog.findByIdAndDelete(entry._id)).rejects.toThrow(/append-only/);
    entry.reason = 'edited';
    await expect(entry.save()).rejects.toThrow(/append-only/);
  });
});

describe('users', () => {
  it('does not return the password hash unless selected', async () => {
    await User.create({ name: 'C', email: 'hidden@example.com', passwordHash: 'h' });
    expect((await User.findOne({ email: 'hidden@example.com' }).orFail()).passwordHash).toBeUndefined();
    expect((await User.findOne({ email: 'hidden@example.com' }).select('+passwordHash').orFail()).passwordHash).toBe('h');
  });
});
