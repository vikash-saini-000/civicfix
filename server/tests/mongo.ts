import { inject } from 'vitest';

/** The shared test MongoDB started in globalSetup. `stop` is a no-op: the global teardown stops it. */
export async function testMongo() {
  const uri = inject('mongoUri');
  return { getUri: () => uri, stop: async () => undefined };
}
