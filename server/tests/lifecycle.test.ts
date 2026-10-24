// Real MongoDB (in-memory) connection lifecycle, readiness and graceful shutdown.
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  DatabaseConnectionError,
  connectDatabase,
  disconnectDatabase,
  isDatabaseConnected,
  pingDatabase,
} from '../src/config/database.js';
import { createLogger } from '../src/utils/logger.js';
import { createShutdown } from '../src/utils/shutdown.js';
import { testAuthConfig } from './helpers.js';

const logger = createLogger({ logLevel: 'silent', nodeEnv: 'test' });

describe('database connection', () => {
  let mongo: MongoMemoryServer;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
  });
  afterAll(async () => {
    await disconnectDatabase();
    await mongo?.stop();
  });

  it('fails clearly and safely when MongoDB is unreachable', async () => {
    const err = await connectDatabase({
      uri: 'mongodb://admin:s3cretpw@127.0.0.1:1/civicfix',
      serverSelectionTimeoutMs: 500,
      autoIndex: false,
      logger,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DatabaseConnectionError);
    expect(err.message).toMatch(/^Could not connect to MongoDB/);
    expect(err.message).not.toContain('s3cretpw');
    expect(isDatabaseConnected()).toBe(false);
  });

  it('connects once even when called concurrently, and reports readiness', async () => {
    const opts = { uri: mongo.getUri(), serverSelectionTimeoutMs: 5000, autoIndex: false, logger };
    const [a, b] = await Promise.all([connectDatabase(opts), connectDatabase(opts)]);
    expect(a).toBe(b);
    expect(isDatabaseConnected()).toBe(true);
    expect(await pingDatabase()).toBe(true);

    const app = createApp({
      config: { nodeEnv: 'test', corsOrigins: [], jsonBodyLimit: '100kb', auth: testAuthConfig },
      logger,
      isDatabaseConnected,
      checkDatabase: () => pingDatabase(),
      isShuttingDown: () => false,
    });
    expect((await request(app).get('/health/ready')).status).toBe(200);
    expect((await request(app).get('/api/v1/x')).status).toBe(404);

    await disconnectDatabase();
    expect(isDatabaseConnected()).toBe(false);
    expect(await pingDatabase()).toBe(false);
    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.checks.database).toBe('down');
    expect((await request(app).get('/api/v1/x')).status).toBe(503);
  });
});

describe('graceful shutdown', () => {
  async function startSlowServer(holdMs: number) {
    const server = createServer((_req, res) => {
      setTimeout(() => res.end('done'), holdMs);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { server, port: (server.address() as AddressInfo).port };
  }

  const get = (port: number) =>
    new Promise<{ status?: number; body: string }>((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port, path: '/' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
        .on('error', reject)
        .end();
    });

  const waitForConnection = (server: Server) =>
    new Promise<void>((r) => server.once('request', () => r()));

  it('lets in-flight requests finish, refuses new ones, and cleans up once', async () => {
    const { server, port } = await startSlowServer(300);
    let closes = 0;
    const lifecycle = createShutdown({ server, logger, timeoutMs: 5000, onClose: async () => void closes++ });

    const inFlight = get(port);
    await waitForConnection(server);
    const first = lifecycle.shutdown('SIGTERM');
    const second = lifecycle.shutdown('SIGINT');
    expect(second).toBe(first);
    expect(lifecycle.isShuttingDown()).toBe(true);

    await expect(get(port)).rejects.toThrow(); // listener closed
    expect(await inFlight).toEqual({ status: 200, body: 'done' });
    expect(await first).toBe(0);
    expect(closes).toBe(1);
  });

  it('forces connections closed after the timeout and exits non-zero', async () => {
    const { server, port } = await startSlowServer(60_000);
    let closed = false;
    const lifecycle = createShutdown({ server, logger, timeoutMs: 200, onClose: async () => void (closed = true) });

    const inFlight = get(port).catch((e: Error) => e);
    await waitForConnection(server);
    expect(await lifecycle.shutdown('SIGTERM')).toBe(1);
    expect(closed).toBe(true);
    expect(await inFlight).toBeInstanceOf(Error);
  });
});
