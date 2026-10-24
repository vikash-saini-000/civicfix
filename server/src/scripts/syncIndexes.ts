// Creates/updates indexes for every model. Use in production, where autoIndex is off.
// Note: syncIndexes also drops indexes that are no longer defined in the schemas.
import { existsSync } from 'node:fs';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase, safeError } from '../config/database.js';
import { loadConfig } from '../config/env.js';
import * as models from '../models/index.js';
import { createLogger } from '../utils/logger.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const logger = createLogger(config);

try {
  await connectDatabase({ uri: config.mongodbUri, serverSelectionTimeoutMs: config.dbServerSelectionTimeoutMs, autoIndex: false, logger });
  for (const model of Object.values(models)) {
    if (typeof model === 'function' && model.prototype instanceof mongoose.Model) {
      const dropped = await (model as mongoose.Model<unknown>).syncIndexes();
      logger.info({ model: model.modelName, dropped }, 'indexes synced');
    }
  }
} catch (err) {
  logger.fatal({ err: safeError(err) }, 'index sync failed');
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
