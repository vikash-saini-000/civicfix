// Builds the app and its background services from validated config. Shared by the long-running
// server (server.ts) and the Vercel function (vercel.ts). Does not connect to MongoDB or listen.
import { createAnthropicProvider } from './ai/anthropicProvider.js';
import { createOpenAiCompatibleEmbeddings, disabledEmbeddings } from './ai/embeddings.js';
import { disabledProvider } from './ai/types.js';
import { createApp } from './app.js';
import { isDatabaseConnected, pingDatabase, safeError } from './config/database.js';
import type { Config } from './config/env.js';
import { createEventBus } from './events/bus.js';
import { detectVideoTools } from './media/video.js';
import { createTurnstileVerifier, disabledCaptcha } from './middleware/captcha.js';
// Registers every model on the default connection.
import './models/index.js';
import { createAnalysisService } from './services/analysis/index.js';
import { createGeocoder } from './services/geocode.js';
import { DEFAULT_VERIFICATION_POLICY } from './services/resolution.js';
import { createSlaMonitor } from './services/slaMonitor.js';
import { createCloudinaryStorage, type DirectUploads } from './storage/cloudinary.js';
import { createLocalStorage, disabledStorage, type ObjectStorage } from './storage/index.js';
import type { Logger } from './utils/logger.js';

/** Staged direct uploads older than this are deleted by the daily maintenance run. */
const STAGING_MAX_AGE_MS = 24 * 60 * 60_000;

export async function buildRuntime(config: Config, logger: Logger, opts: { isShuttingDown: () => boolean }) {
  // AI analysis runs in the background; with AI_PROVIDER=disabled only the rule-based duplicate check runs.
  const provider = config.ai.provider === 'anthropic' ? createAnthropicProvider(config.ai) : disabledProvider;

  let storage: ObjectStorage = disabledStorage;
  let directUploads: DirectUploads | undefined;
  if (config.storage.provider === 'cloudinary' && config.storage.cloudinary) {
    const cloudinary = createCloudinaryStorage({ ...config.storage.cloudinary, tokenSecret: config.auth.jwtSecret });
    storage = cloudinary;
    directUploads = cloudinary.directUploads;
  } else if (config.storage.provider === 'local') {
    storage = createLocalStorage(config.storage.localDir);
  }

  const captcha =
    config.captcha.provider === 'turnstile' && config.captcha.secretKey
      ? createTurnstileVerifier({ secretKey: config.captcha.secretKey, allowedHostnames: config.captcha.allowedHostnames, logger })
      : disabledCaptcha;
  if (config.nodeEnv === 'production' && !captcha.enabled) logger.warn('CAPTCHA_PROVIDER=disabled: register, login and new complaints have no human check');

  const embeddings =
    config.ai.embeddingModel && config.ai.baseURL && config.ai.apiKey
      ? createOpenAiCompatibleEmbeddings({ baseURL: config.ai.baseURL, apiKey: config.ai.apiKey, model: config.ai.embeddingModel, timeoutMs: config.ai.timeoutMs })
      : disabledEmbeddings;
  // Video frames, details and privacy copies need ffmpeg; without it videos get metadata-only checks.
  const video = await detectVideoTools({ ffmpegPath: config.video.ffmpegPath, ffprobePath: config.video.ffprobePath });
  if (!video.enabled) logger.warn('ffmpeg/ffprobe not found: videos will only get metadata checks (set FFMPEG_PATH / FFPROBE_PATH)');

  const events = createEventBus(logger);
  const sla = createSlaMonitor({ events, logger });
  const analysis = createAnalysisService({
    embeddings,
    provider,
    logger,
    maxAttempts: config.ai.maxAttempts,
    autoRun: true,
    storage,
    triageMode: config.ai.triageMode,
    mediaUploadGate: config.ai.mediaUploadGate,
    video,
    agentMaxTurns: config.ai.agentMaxTurns,
    callTimeoutMs: config.ai.timeoutMs,
  });
  logger.info(
    {
      aiProvider: provider.name,
      aiGateway: provider.enabled ? (config.ai.baseURL ? 'aicredits' : 'anthropic') : undefined,
      aiModel: provider.enabled ? provider.model : undefined,
      aiTriageMode: provider.enabled ? config.ai.triageMode : undefined,
      embeddings: embeddings.enabled ? embeddings.model : 'disabled',
      storage: config.storage.provider,
      directUploads: !!directUploads,
      captcha: config.captcha.provider,
      video: video.version ?? 'disabled',
      uploadGate: config.ai.mediaUploadGate,
      evidenceCapture: config.capture.mode,
    },
    'analysis configured',
  );

  /** Daily housekeeping (Vercel Cron, or any scheduler): leftover jobs, SLA breaches, stale staged uploads. */
  async function maintenance(deadline: number) {
    const result: Record<string, number | string> = {};
    try {
      result.slaBreaches = await sla.checkOnce();
    } catch (err) {
      logger.error({ err: safeError(err) }, 'maintenance: SLA check failed');
      result.slaBreaches = 'failed';
    }
    if (directUploads) {
      try {
        result.stagedUploadsRemoved = await directUploads.cleanupStaging(STAGING_MAX_AGE_MS);
      } catch (err) {
        logger.error({ err: safeError(err) }, 'maintenance: staged upload cleanup failed');
        result.stagedUploadsRemoved = 'failed';
      }
    }
    await analysis.runner.runUntilQuiet(deadline);
    return result;
  }

  const app = createApp({
    analysis,
    events,
    storage,
    directUploads,
    captcha,
    video,
    maxVideoSeconds: config.video.maxSeconds,
    capture: config.capture,
    geocoder: createGeocoder(config.geocode, logger),
    verificationPolicy: { ...DEFAULT_VERIFICATION_POLICY, autoApprove: config.verification.autoApprove, disputeWindowDays: config.verification.disputeWindowDays },
    maintenance: config.cronSecret ? { secret: config.cronSecret, run: maintenance } : undefined,
    config,
    logger,
    isDatabaseConnected,
    checkDatabase: () => pingDatabase(),
    isShuttingDown: opts.isShuttingDown,
  });

  return { app, analysis, sla, storage };
}
export type Runtime = Awaited<ReturnType<typeof buildRuntime>>;
