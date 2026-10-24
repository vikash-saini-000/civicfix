// Creates an account outside public registration, e.g. the first platform admin.
//   NEW_USER_PASSWORD='…' npm run user:create -- --email admin@example.org --name "Admin" --role PLATFORM_ADMIN
// The password is read from the NEW_USER_PASSWORD environment variable so it never appears in argv or logs.
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword } from '../auth/password.js';
import { connectDatabase, disconnectDatabase, safeError } from '../config/database.js';
import { loadConfig } from '../config/env.js';
import { PLATFORM_ROLES } from '../models/enums.js';
import { AuditLog, User } from '../models/index.js';
import { createLogger } from '../utils/logger.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'CITIZEN' } },
});
const parsed = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    name: z.string().trim().min(1).max(100),
    role: z.enum(PLATFORM_ROLES),
    password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  })
  .safeParse({ ...values, password: process.env.NEW_USER_PASSWORD });

if (!parsed.success) {
  console.error('Usage: NEW_USER_PASSWORD=… npm run user:create -- --email <email> --name <name> [--role CITIZEN|PLATFORM_ADMIN]');
  for (const issue of parsed.error.issues) console.error(`- ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

const config = loadConfig();
const logger = createLogger(config);
const { email, name, role, password } = parsed.data;

try {
  await connectDatabase({ uri: config.mongodbUri, serverSelectionTimeoutMs: config.dbServerSelectionTimeoutMs, autoIndex: false, logger });
  if (await User.exists({ email })) throw new Error('An account with this email already exists.');
  const user = await User.create({ name, email, platformRole: role, passwordHash: await hashPassword(password) });
  await AuditLog.create({
    actorType: 'SYSTEM',
    action: 'user.provisioned',
    targetType: 'User',
    targetId: user._id,
    outcome: 'SUCCESS',
    reason: `created via CLI with platform role ${role}`,
  });
  logger.info({ userId: String(user._id), platformRole: role }, 'user created');
} catch (err) {
  logger.fatal({ err: safeError(err) }, 'user creation failed');
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
