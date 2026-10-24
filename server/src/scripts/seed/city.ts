// Creates the simulated city: wards, mapped places, departments with ward coverage, and department
// staff (managers, on-duty and off-duty workers). Idempotent. Shared by db:seed and the evaluation.
import type { Types } from 'mongoose';
import type { Category, MembershipRole, PlatformRole } from '../../models/enums.js';
import { AuditLog, Department, DepartmentMembership, Place, User, Ward } from '../../models/index.js';
import { DEPARTMENTS, PLACES, WARDS, wardPolygon } from './cityData.js';
import type { SeedDepartment } from './demoComplaints.js';

export type CityDepartment = SeedDepartment & { name: string; categories: Category[]; wards: string[] };

export interface CityResult {
  created: number;
  wardIds: Map<string, Types.ObjectId>;
  departments: Map<string, CityDepartment>;
  /** Printable list of staff accounts. */
  staff: { role: string; department: string; email: string }[];
  /** The department that should handle a category at a ward (ward-specific first, then city-wide). */
  deptFor: (category: Category, wardCode: string | null) => CityDepartment;
}

export async function ensureUser(email: string, name: string, platformRole: PlatformRole, passwordHash: string): Promise<{ doc: InstanceType<typeof User>; created: boolean }> {
  const existing = await User.findOne({ email });
  if (existing) return { doc: existing, created: false };
  const user = await User.create({ name, email, platformRole, passwordHash });
  await AuditLog.create({ actorType: 'SYSTEM', action: 'user.provisioned', targetType: 'User', targetId: user._id, outcome: 'SUCCESS', reason: `created by seed with platform role ${platformRole}` });
  return { doc: user, created: true };
}

export async function seedCity(opts: { passwordHash: string; domain: string }): Promise<CityResult> {
  let created = 0;
  const wardIds = new Map<string, Types.ObjectId>();
  for (const w of WARDS) {
    const res = await Ward.findOneAndUpdate(
      { code: w.code },
      { $setOnInsert: { code: w.code, name: w.name, population: w.population, boundary: wardPolygon(w) } },
      { upsert: true, returnDocument: 'after', includeResultMetadata: true },
    );
    if (!res.lastErrorObject?.updatedExisting) created++;
    wardIds.set(w.code, res.value!._id);
  }
  for (const p of PLACES) {
    const geometry = p.point ? { type: 'Point', coordinates: [p.point[1], p.point[0]] } : { type: 'LineString', coordinates: p.line!.map(([lat, lng]) => [lng, lat]) };
    const ward = p.point ? await Ward.findOne({ boundary: { $geoIntersects: { $geometry: geometry } } }).select('_id').lean() : null;
    const res = await Place.updateOne({ name: p.name }, { $setOnInsert: { name: p.name, kind: p.kind, geometry, ward: ward?._id } }, { upsert: true });
    if (res.upsertedCount) created++;
  }

  const ensure = async (email: string, name: string) => {
    const u = await ensureUser(email, name, 'CITIZEN', opts.passwordHash);
    if (u.created) created++;
    return u.doc;
  };
  const member = async (user: Types.ObjectId, department: Types.ObjectId, role: MembershipRole, onDuty = true) => {
    const res = await DepartmentMembership.updateOne({ user, department }, { $setOnInsert: { role, status: 'ACTIVE', onDuty } }, { upsert: true });
    if (res.upsertedCount) created++;
  };

  const departments = new Map<string, CityDepartment>();
  const staff: CityResult['staff'] = [];
  for (const d of DEPARTMENTS) {
    let dept = await Department.findOne({ name: d.name }).collation({ locale: 'en', strength: 2 });
    const wards = d.wards.map((c) => wardIds.get(c)!);
    if (!dept) {
      dept = await Department.create({ name: d.name, description: d.description, categories: d.categories, wards });
      created++;
    } else if (d.wards.length > 0 && (dept.wards?.length ?? 0) === 0) {
      // Earlier seeds created this department city-wide; give it its zone now.
      dept.wards = wards;
      dept.description = d.description;
      await dept.save();
    }
    const manager = await ensure(`${d.key}.manager@${opts.domain}`, `${d.name} Manager`);
    await member(manager._id, dept._id, 'MANAGER');
    staff.push({ role: 'MANAGER', department: d.name, email: `${d.key}.manager@${opts.domain}` });
    const workers: Types.ObjectId[] = [];
    for (let i = 1; i <= d.workers + (d.offDutyWorkers ?? 0); i++) {
      const onDuty = i <= d.workers;
      const user = await ensure(`${d.key}.worker${i}@${opts.domain}`, `${d.name} Worker ${i}`);
      await member(user._id, dept._id, 'MEMBER', onDuty);
      if (onDuty) workers.push(user._id);
      staff.push({ role: onDuty ? 'MEMBER' : 'MEMBER (off duty)', department: d.name, email: `${d.key}.worker${i}@${opts.domain}` });
    }
    departments.set(d.key, { _id: dept._id, key: d.key, name: d.name, manager: manager._id, workers, categories: d.categories, wards: d.wards });
  }

  const all = [...departments.values()];
  const deptFor = (category: Category, wardCode: string | null) =>
    all.find((d) => d.categories.includes(category) && d.wards.length > 0 && !!wardCode && d.wards.includes(wardCode)) ??
    all.find((d) => d.categories.includes(category) && d.wards.length === 0) ??
    all.find((d) => d.categories.includes(category))!;
  return { created, wardIds, departments, staff, deptFor };
}
