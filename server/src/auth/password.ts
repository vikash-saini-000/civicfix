import { hash, verify } from '@node-rs/argon2';

// Algorithm.Argon2id is a const enum, which verbatimModuleSyntax can't import; its value is 2.
const ARGON2ID = 2;

// Argon2id with the OWASP-recommended minimum (19 MiB memory, 2 iterations, 1 lane).
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** Library's constant-time verify. Returns false (never throws) for malformed hashes. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Verified against when the email is unknown, so "no such user" takes as long as "wrong password".
let dummyHash: Promise<string> | null = null;
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('civicfix-timing-equalizer-not-a-real-password');
  await verifyPassword(await dummyHash, password);
  return false;
}
