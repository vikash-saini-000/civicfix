// Central environment configuration. Validates once at startup and never echoes secret values.

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  nodeEnv: NodeEnv;
  host: string;
  port: number;
  mongodbUri: string;
  /** Exact origins allowed by CORS, e.g. http://localhost:5173. */
  corsOrigins: string[];
  /** Max JSON body size, in a form express.json() accepts, e.g. "100kb". */
  jsonBodyLimit: string;
  logLevel: LogLevel;
  shutdownTimeoutMs: number;
  dbServerSelectionTimeoutMs: number;
  /** Number of trusted reverse-proxy hops in front of the app (0 = none). Affects req.ip. */
  trustProxyHops: number;
  auth: AuthConfig;
  ai: AiConfig;
  storage: StorageConfig;
  verification: VerificationConfig;
}

export const STORAGE_PROVIDERS = ['disabled', 'local'] as const;
export interface StorageConfig {
  provider: (typeof STORAGE_PROVIDERS)[number];
  /** Directory for STORAGE_PROVIDER=local. */
  localDir: string;
}

export interface VerificationConfig {
  /** Approve a resolution without a human when every rule passes. Off unless the product owner turns it on. */
  autoApprove: boolean;
  /** Days after resolution during which the citizen may dispute (and staff may not close). */
  disputeWindowDays: number;
}

export const AI_PROVIDERS = ['disabled', 'anthropic'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

/** AiCredits.in prepaid gateway for the Anthropic Messages API. Fixed (not configurable) so the key only ever goes to this host. */
export const AICREDITS_BASE_URL = 'https://api.aicredits.in';

export interface AiConfig {
  /** `disabled` keeps everything working without AI: complaints go to manual triage. */
  provider: AiProviderName;
  apiKey?: string;
  /** Set when Anthropic calls go through a gateway (AiCredits.in) instead of api.anthropic.com. */
  baseURL?: string;
  model: string;
  timeoutMs: number;
  /** Attempts per analysis job, including the first. Only transient failures are retried. */
  maxAttempts: number;
  /** `single` = one classification call per complaint; `agent` = bounded tool-using triage agent. */
  triageMode: AiTriageMode;
  /** Max model calls per agent run (agent mode only). */
  agentMaxTurns: number;
  /**
   * Semantic duplicate search (OpenAI-compatible embeddings through the same gateway). Only available
   * with AICREDITS_API_KEY; `null` = off (duplicates use word overlap).
   */
  embeddingModel: string | null;
}

export const AI_TRIAGE_MODES = ['single', 'agent'] as const;
export type AiTriageMode = (typeof AI_TRIAGE_MODES)[number];

export const SAME_SITE_VALUES = ['strict', 'lax', 'none'] as const;
export type SameSite = (typeof SAME_SITE_VALUES)[number];

export interface AuthConfig {
  /** HS256 signing key for access tokens. At least 32 characters. */
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  cookieSecure: boolean;
  cookieSameSite: SameSite;
}

/** Placeholder-looking secrets that must never be accepted. */
const WEAK_SECRET = /change[-_ ]?me|placeholder|secret|example|^(.)\1+$/i;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

/** Parses and validates configuration. Throws ConfigError listing every problem (names only, never values). */
export function loadConfig(env: Env = process.env): Config {
  const issues: string[] = [];
  const read = (name: string) => {
    const v = env[name]?.trim();
    return v === '' ? undefined : v;
  };

  const nodeEnv = (read('NODE_ENV') ?? 'development') as NodeEnv;
  if (!NODE_ENVS.includes(nodeEnv)) issues.push(`NODE_ENV must be one of ${NODE_ENVS.join(', ')}`);
  const isProd = nodeEnv === 'production';

  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max) {
      issues.push(`${name} must be a whole number from ${min} to ${max}`);
      return fallback;
    }
    return n;
  };

  const port = int('PORT', 4000, 1, 65535);
  const shutdownTimeoutMs = int('SHUTDOWN_TIMEOUT_MS', 10_000, 1_000, 120_000);
  const dbServerSelectionTimeoutMs = int('DB_SERVER_SELECTION_TIMEOUT_MS', 10_000, 500, 120_000);
  const trustProxyHops = int('TRUST_PROXY', 0, 0, 10);
  const host = read('HOST') ?? '0.0.0.0';

  const mongodbUri = read('MONGODB_URI') ?? '';
  if (!mongodbUri) issues.push('MONGODB_URI is required');
  else if (!/^mongodb(\+srv)?:\/\/[^/\s]+/.test(mongodbUri)) {
    issues.push('MONGODB_URI must start with mongodb:// or mongodb+srv:// and include a host');
  }

  const corsOrigins: string[] = [];
  for (const origin of (read('CORS_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean)) {
    if (origin === '*') {
      issues.push('CORS_ORIGINS must list exact origins; "*" is not allowed');
      continue;
    }
    try {
      const u = new URL(origin);
      if (!['http:', 'https:'].includes(u.protocol) || u.origin !== origin) throw new Error();
      if (isProd && u.protocol !== 'https:') issues.push('CORS_ORIGINS must use https in production');
      corsOrigins.push(origin);
    } catch {
      issues.push('CORS_ORIGINS must be a comma-separated list of origins like https://example.org (no paths or trailing slash)');
    }
  }
  if (isProd && corsOrigins.length === 0) issues.push('CORS_ORIGINS is required in production');

  const jsonBodyLimit = (read('JSON_BODY_LIMIT') ?? '100kb').toLowerCase();
  const limitMatch = /^(\d+)(b|kb|mb)$/.exec(jsonBodyLimit);
  const limitBytes = limitMatch ? Number(limitMatch[1]) * { b: 1, kb: 1024, mb: 1024 ** 2 }[limitMatch[2] as 'b' | 'kb' | 'mb'] : 0;
  if (!limitMatch || limitBytes < 1024 || limitBytes > 1024 ** 2) {
    issues.push('JSON_BODY_LIMIT must be a size like 100kb, between 1kb and 1mb');
  }

  const jwtSecret = read('JWT_SECRET') ?? '';
  if (!jwtSecret) issues.push('JWT_SECRET is required');
  else if (jwtSecret.length < 32) issues.push('JWT_SECRET must be at least 32 characters');
  else if (WEAK_SECRET.test(jwtSecret)) issues.push('JWT_SECRET looks like a placeholder; generate a random value');
  const accessTokenTtlSeconds = int('ACCESS_TOKEN_TTL_SECONDS', 900, 60, 3600);
  const refreshTokenTtlDays = int('REFRESH_TOKEN_TTL_DAYS', 7, 1, 30);

  const secureRaw = read('COOKIE_SECURE');
  if (secureRaw !== undefined && !['true', 'false'].includes(secureRaw)) issues.push('COOKIE_SECURE must be true or false');
  const cookieSecure = secureRaw === undefined ? isProd : secureRaw === 'true';
  if (isProd && !cookieSecure) issues.push('COOKIE_SECURE cannot be false in production');
  const cookieSameSite = (read('COOKIE_SAMESITE') ?? 'lax').toLowerCase() as SameSite;
  if (!SAME_SITE_VALUES.includes(cookieSameSite)) issues.push(`COOKIE_SAMESITE must be one of ${SAME_SITE_VALUES.join(', ')}`);
  if (cookieSameSite === 'none' && !cookieSecure) issues.push('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');

  const aiProvider = (read('AI_PROVIDER') ?? 'disabled') as AiProviderName;
  if (!AI_PROVIDERS.includes(aiProvider)) issues.push(`AI_PROVIDER must be one of ${AI_PROVIDERS.join(', ')}`);
  const anthropicKey = read('ANTHROPIC_API_KEY');
  const aicreditsKey = read('AICREDITS_API_KEY');
  if (aiProvider === 'anthropic') {
    // Exactly one key, so it is never ambiguous which account gets billed.
    if (anthropicKey && aicreditsKey) issues.push('Set only one of ANTHROPIC_API_KEY or AICREDITS_API_KEY');
    else if (!anthropicKey && !aicreditsKey) issues.push('ANTHROPIC_API_KEY or AICREDITS_API_KEY is required when AI_PROVIDER=anthropic');
  }
  const viaAiCredits = aiProvider === 'anthropic' && !!aicreditsKey && !anthropicKey;
  const aiModelRaw = read('AI_MODEL');
  // AiCredits uses its own model IDs, so the direct-API default would not be valid there.
  if (viaAiCredits && !aiModelRaw) issues.push('AI_MODEL is required with AICREDITS_API_KEY (an ID from the AiCredits catalog, e.g. anthropic/claude-sonnet-4.6)');
  const aiModel = aiModelRaw ?? 'claude-opus-5-5';
  // Optional "vendor/" prefix for gateway IDs such as anthropic/claude-sonnet-4.6.
  if (!/^(?:[a-z0-9-]{2,32}\/)?[a-z0-9][a-z0-9.-]{2,63}$/.test(aiModel)) issues.push('AI_MODEL must be a model ID like claude-opus-5-5 or anthropic/claude-sonnet-4.6');
  const aiTimeoutMs = int('AI_TIMEOUT_MS', 30_000, 5_000, 120_000);
  const aiMaxAttempts = int('AI_MAX_ATTEMPTS', 3, 1, 5);
  const aiTriageMode = (read('AI_TRIAGE_MODE') ?? 'single') as AiTriageMode;
  if (!AI_TRIAGE_MODES.includes(aiTriageMode)) issues.push(`AI_TRIAGE_MODE must be one of ${AI_TRIAGE_MODES.join(', ')}`);
  const aiAgentMaxTurns = int('AI_AGENT_MAX_TURNS', 6, 2, 10);
  // On by default through AiCredits (about $0.000002 per complaint); "disabled" turns it off.
  const embeddingRaw = read('EMBEDDING_MODEL') ?? (viaAiCredits ? 'text-embedding-3-small' : 'disabled');
  if (embeddingRaw !== 'disabled' && !/^(?:[a-z0-9-]{2,32}\/)?[a-z0-9][a-z0-9.-]{2,63}$/.test(embeddingRaw)) issues.push('EMBEDDING_MODEL must be a model ID like text-embedding-3-small, or disabled');
  if (embeddingRaw !== 'disabled' && !viaAiCredits) issues.push('EMBEDDING_MODEL needs AI_PROVIDER=anthropic with AICREDITS_API_KEY (or set it to disabled)');
  const embeddingModel = embeddingRaw === 'disabled' ? null : embeddingRaw;

  const storageProvider = (read('STORAGE_PROVIDER') ?? 'disabled') as StorageConfig['provider'];
  if (!STORAGE_PROVIDERS.includes(storageProvider)) issues.push(`STORAGE_PROVIDER must be one of ${STORAGE_PROVIDERS.join(', ')}`);
  const storageLocalDir = read('STORAGE_LOCAL_DIR') ?? './uploads';
  const autoApproveRaw = read('AUTO_APPROVE_RESOLUTIONS') ?? 'false';
  if (!['true', 'false'].includes(autoApproveRaw)) issues.push('AUTO_APPROVE_RESOLUTIONS must be true or false');
  const disputeWindowDays = int('DISPUTE_WINDOW_DAYS', 14, 1, 90);

  const logLevel = (read('LOG_LEVEL') ?? (nodeEnv === 'test' ? 'silent' : 'info')) as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) issues.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    nodeEnv,
    host,
    port,
    mongodbUri,
    corsOrigins,
    jsonBodyLimit,
    logLevel,
    shutdownTimeoutMs,
    dbServerSelectionTimeoutMs,
    trustProxyHops,
    auth: { jwtSecret, accessTokenTtlSeconds, refreshTokenTtlDays, cookieSecure, cookieSameSite },
    ai: {
      provider: aiProvider,
      apiKey: viaAiCredits ? aicreditsKey : anthropicKey,
      baseURL: viaAiCredits ? AICREDITS_BASE_URL : undefined,
      model: aiModel,
      timeoutMs: aiTimeoutMs,
      maxAttempts: aiMaxAttempts,
      triageMode: aiTriageMode,
      agentMaxTurns: aiAgentMaxTurns,
      embeddingModel,
    },
    storage: { provider: storageProvider, localDir: storageLocalDir },
    verification: { autoApprove: autoApproveRaw === 'true', disputeWindowDays },
  };
}

/** Removes credentials and query options from a MongoDB URI so it is safe to log. */
export function redactMongoUri(uri: string): string {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?([^/?]*).*$/, '$1***@$2');
}

/** Scrubs anything that looks like a connection string or credentials from free text (e.g. driver errors). */
export function redactSecrets(text: string): string {
  return text.replace(/mongodb(\+srv)?:\/\/\S+/g, 'mongodb://[redacted]');
}
