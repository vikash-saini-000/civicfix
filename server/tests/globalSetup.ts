// One in-memory MongoDB for the whole test run (each test file uses its own database name).
// Starting one server per file in parallel was slow enough to hit start-up timeouts.
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import type { TestProject } from 'vitest/node';

let server: MongoMemoryServer | undefined;

export async function setup(project: TestProject) {
  server = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  project.provide('mongoUri', server.getUri());
}

export async function teardown() {
  await server?.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
