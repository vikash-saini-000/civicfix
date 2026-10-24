// Demo data for local development (refuses to run in production):
//   - city reference data: 8 wards and ~25 mapped places (schools, hospitals, main roads, markets...)
//   - departments with ward coverage (roads split into North and South zones), managers, workers,
//     and an off-duty worker in some departments (staff roster)
//   - accounts: admin@civicfix.local, citizen@civicfix.local, resident01..25@civicfix.local
//   - ~150 demo complaints (Jan 2025 – today) with work orders, duplicates, review queue, feedback
//
//   SEED_PASSWORD='…' npm run db:seed            (or put SEED_PASSWORD in server/.seed-credentials)
//   SEED_PASSWORD='…' npm run db:seed -- --no-complaints     (reference data and accounts only)
//
// Every seeded account gets SEED_PASSWORD (from the environment, never argv or logs). Safe to re-run:
// existing records are kept; demo complaints are generated only once per database.
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Types } from 'mongoose';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword } from '../auth/password.js';
import { connectDatabase, disconnectDatabase, safeError } from '../config/database.js';
import { loadConfig } from '../config/env.js';
import { Counter, Place, Ward } from '../models/index.js';
import { createLogger } from '../utils/logger.js';
import { PLACES, WARDS } from './seed/cityData.js';
import { ensureUser, seedCity } from './seed/city.js';
import { seedDemoComplaints } from './seed/demoComplaints.js';

if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.SEED_PASSWORD && existsSync('.seed-credentials')) process.loadEnvFile('.seed-credentials');
const { values: flags } = parseArgs({ options: { 'no-complaints': { type: 'boolean', default: false } } });

const config = loadConfig();
const logger = createLogger(config);

if (config.nodeEnv === 'production') {
  console.error('db:seed creates demo accounts and is disabled when NODE_ENV=production.');
  process.exit(1);
}
const password = process.env.SEED_PASSWORD ?? '';
if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
  console.error(`Usage: SEED_PASSWORD=<${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters> npm run db:seed`);
  process.exit(1);
}

const DOMAIN = 'civicfix.local';
const DEMO_MARKER = 'seed:demo-complaints-v1';

try {
  await connectDatabase({ uri: config.mongodbUri, serverSelectionTimeoutMs: config.dbServerSelectionTimeoutMs, autoIndex: true, logger });
  await Promise.all([Ward.syncIndexes(), Place.syncIndexes()]);
  const passwordHash = await hashPassword(password);

  const city = await seedCity({ passwordHash, domain: DOMAIN });
  let created = city.created;
  const add = async (email: string, name: string, role: 'CITIZEN' | 'PLATFORM_ADMIN') => {
    const u = await ensureUser(email, name, role, passwordHash);
    if (u.created) created++;
    return u.doc;
  };
  const admin = await add(`admin@${DOMAIN}`, 'Platform Admin', 'PLATFORM_ADMIN');
  await add(`citizen@${DOMAIN}`, 'Asha Citizen', 'CITIZEN');
  const citizens: Types.ObjectId[] = [];
  for (let i = 1; i <= 25; i++) {
    const n = String(i).padStart(2, '0');
    citizens.push((await add(`resident${n}@${DOMAIN}`, `Resident ${n}`, 'CITIZEN'))._id);
  }

  let demo: Awaited<ReturnType<typeof seedDemoComplaints>> | null = null;
  if (!flags['no-complaints'] && !(await Counter.exists({ _id: DEMO_MARKER }))) {
    demo = await seedDemoComplaints({
      now: new Date(),
      citizens,
      wards: WARDS.map((w) => ({ _id: city.wardIds.get(w.code)!, code: w.code, bounds: w.bounds })),
      deptFor: city.deptFor,
    });
    await Counter.create({ _id: DEMO_MARKER, seq: 1 });
  }

  console.log(`\nSeed complete: ${created} new account/reference record(s). Seeded accounts use SEED_PASSWORD (existing accounts keep their password).`);
  console.log(`City data: ${WARDS.length} wards, ${PLACES.length} places. Admin: ${admin.email}`);
  if (demo) console.log(`Demo complaints: ${demo.complaints} (${demo.workOrders} work orders, ${demo.duplicates} linked duplicates, ${demo.reviewQueue} waiting for a routing decision).`);
  else if (!flags['no-complaints']) console.log('Demo complaints: already present (skipped).');
  console.log('');
  console.table([
    { role: 'PLATFORM_ADMIN', department: '-', email: `admin@${DOMAIN}` },
    { role: 'CITIZEN', department: '-', email: `citizen@${DOMAIN}` },
    { role: 'CITIZEN', department: '-', email: `resident01..25@${DOMAIN}` },
    ...city.staff,
  ]);
} catch (err) {
  logger.fatal({ err: safeError(err) }, 'seed failed');
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
