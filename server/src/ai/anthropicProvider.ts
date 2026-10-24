// Claude adapter. The only file that imports the Anthropic SDK; everything vendor-specific stays here.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import type { AiConfig } from '../config/env.js';
import {
  CLASSIFY_PROMPT_VERSION,
  CLASSIFY_SYSTEM,
  IMAGE_PROMPT_VERSION,
  IMAGE_SYSTEM,
  classifyUserMessage,
  imageUserMessage,
} from './prompts.js';
import {
  AiProviderError,
  classificationOutputSchema,
  imageAssessmentSchema,
  type AiProvider,
  type AiResult,
  type ClassificationInput,
  type ClassificationOutput,
  type ImageAssessment,
  type ImageAssessmentInput,
} from './types.js';

// Models that accept server-side refusal fallbacks ("default" routing by refusal category).
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/** Maps SDK errors to provider-independent kinds. Most specific first. */
function toProviderError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AiProviderError('TIMEOUT', 'The AI provider timed out.');
  if (err instanceof Anthropic.APIConnectionError) return new AiProviderError('UNAVAILABLE', 'Could not reach the AI provider.');
  if (err instanceof Anthropic.RateLimitError) return new AiProviderError('RATE_LIMITED', 'The AI provider rate-limited the request.');
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AiProviderError('AUTH_FAILED', 'The AI provider rejected the credentials.');
  }
  if (err instanceof Anthropic.BadRequestError) return new AiProviderError('BAD_REQUEST', 'The AI provider rejected the request.');
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 408 || status === 409 || status >= 500) return new AiProviderError('UNAVAILABLE', `The AI provider returned ${status}.`);
    return new AiProviderError('BAD_REQUEST', `The AI provider returned ${status}.`);
  }
  // Output that failed the SDK's schema parse lands here.
  return new AiProviderError('INVALID_OUTPUT', 'The AI response could not be parsed.');
}

export function createAnthropicProvider(config: AiConfig, client?: Anthropic): AiProvider {
  // Retries are owned by the job runner (bounded, with backoff), so the SDK must not retry too.
  const anthropic = client ?? new Anthropic({ apiKey: config.apiKey, maxRetries: 0, timeout: config.timeoutMs });
  const model = config.model;
  const fallback = FALLBACK_MODELS.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : { betas: [] };

  async function call<S extends z.ZodType>(opts: {
    system: string;
    content: Anthropic.Beta.BetaContentBlockParam[] | string;
    schema: S;
    promptVersion: string;
  }): Promise<AiResult<z.infer<S>>> {
    const started = Date.now();
    let response;
    try {
      response = await anthropic.beta.messages.parse(
        {
          model,
          max_tokens: 4096,
          ...fallback,
          // Classification-style task: low effort keeps cost and latency down.
          output_config: { effort: 'low', format: betaZodOutputFormat(opts.schema) },
          system: opts.system,
          messages: [{ role: 'user', content: opts.content }],
        },
        { timeout: config.timeoutMs, maxRetries: 0 },
      );
    } catch (err) {
      throw toProviderError(err);
    }
    if (response.stop_reason === 'refusal') throw new AiProviderError('REFUSED', 'The AI provider declined to analyse this content.');
    if (response.stop_reason === 'max_tokens') throw new AiProviderError('INVALID_OUTPUT', 'The AI response was cut off.');
    // Re-validate locally: the SDK parse is a convenience, our schema is the contract.
    const parsed = opts.schema.safeParse(response.parsed_output);
    if (!parsed.success) throw new AiProviderError('INVALID_OUTPUT', 'The AI response did not match the expected format.');
    return {
      output: parsed.data,
      meta: {
        provider: 'anthropic',
        model: response.model,
        promptVersion: opts.promptVersion,
        latencyMs: Date.now() - started,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      },
    };
  }

  return {
    name: 'anthropic',
    model,
    enabled: true,
    classifyComplaint(input: ClassificationInput): Promise<AiResult<ClassificationOutput>> {
      return call({
        system: CLASSIFY_SYSTEM,
        content: classifyUserMessage({ ...input }),
        schema: classificationOutputSchema(input.departments.map((d) => d.ref)),
        promptVersion: CLASSIFY_PROMPT_VERSION,
      });
    },
    assessImage(input: ImageAssessmentInput): Promise<AiResult<ImageAssessment>> {
      return call({
        system: IMAGE_SYSTEM,
        content: [
          { type: 'image', source: { type: 'base64', media_type: input.mediaType, data: input.base64 } },
          { type: 'text', text: imageUserMessage(input) },
        ],
        schema: imageAssessmentSchema,
        promptVersion: IMAGE_PROMPT_VERSION,
      });
    },
  };
}
