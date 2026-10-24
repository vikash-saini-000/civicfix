// Claude adapter. The only file that imports the Anthropic SDK; everything vendor-specific stays here.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { AiConfig } from '../config/env.js';
import {
  CLASSIFY_PROMPT_VERSION,
  CLASSIFY_SYSTEM,
  COMPARE_PROMPT_VERSION,
  COMPARE_SYSTEM,
  IMAGE_PROMPT_VERSION,
  VIDEO_PROMPT_VERSION,
  VIDEO_SYSTEM,
  IMAGE_SYSTEM,
  PRIVACY_PROMPT_VERSION,
  PRIVACY_SYSTEM,
  classifyUserMessage,
  compareUserMessage,
  imageUserMessage,
} from './prompts.js';
import {
  AiProviderError,
  classificationOutputSchema,
  imageAssessmentSchema,
  privacyRegionsSchema,
  resolutionComparisonSchema,
  type AgentResult,
  type AgentRunInput,
  type AgentStep,
  type AiProvider,
  type VideoAssessmentInput,
  type AiResult,
  type ClassificationInput,
  type ClassificationOutput,
  type ImageAssessment,
  type ImageAssessmentInput,
  type ImageData,
  type PrivacyRegions,
  type ResolutionComparison,
  type ResolutionComparisonInput,
} from './types.js';

/** Max tool calls answered per model turn, and max characters of one tool result sent back. */
const MAX_CALLS_PER_TURN = 5;
const MAX_TOOL_RESULT_CHARS = 8_000;
const TOOL_NAME = /^[a-z_]{1,64}$/;

/** JSON Schema for a tool's input, from its zod schema. */
function toolDef(name: string, description: string, schema: z.ZodType): Anthropic.Beta.BetaTool {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return { name, description, input_schema: json as Anthropic.Beta.BetaTool.InputSchema };
}

/** Validation problems as "path: message", without echoing the rejected values. */
function issuesOf(err: z.ZodError): string {
  return err.issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

// Models that accept server-side refusal fallbacks ("default" routing by refusal category).
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

// Models that reject output_config.effort with a 400. Matches direct IDs and gateway IDs (anthropic/claude-haiku-4.5).
const NO_EFFORT_MODEL = /claude-(haiku|sonnet)-4[.-]5$/;

/** Provider error text for logs: type + message, without anything that looks like a key (Anthropic sk-ant-…, AiCredits sk-…). */
function detailOf(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { type?: string; message?: string } } | undefined;
  return `${err.status ?? '?'} ${body?.error?.type ?? ''} ${body?.error?.message ?? ''}`.replace(/sk-[\w-]{8,}/g, '[key]').trim().slice(0, 300);
}

/** Out of prepaid balance or over the API key's budget: 402, or a billing_error under another status. */
function isBillingError(err: InstanceType<typeof Anthropic.APIError>): boolean {
  const type = (err.error as { error?: { type?: string } } | undefined)?.error?.type;
  return err.status === 402 || type === 'billing_error';
}

/** Maps SDK errors to provider-independent kinds. Most specific first. */
function toProviderError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AiProviderError('TIMEOUT', 'The AI provider timed out.');
  if (err instanceof Anthropic.APIConnectionError) return new AiProviderError('UNAVAILABLE', 'Could not reach the AI provider.');
  if (err instanceof Anthropic.RateLimitError) return new AiProviderError('RATE_LIMITED', 'The AI provider rate-limited the request.');
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AiProviderError('AUTH_FAILED', 'The AI provider rejected the credentials.', detailOf(err));
  }
  if (err instanceof Anthropic.APIError && isBillingError(err)) {
    return new AiProviderError('CREDITS_EXHAUSTED', 'AI credits are exhausted (balance or API key budget).', detailOf(err));
  }
  if (err instanceof Anthropic.BadRequestError) return new AiProviderError('BAD_REQUEST', 'The AI provider rejected the request.', detailOf(err));
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 408 || status === 409 || status >= 500) return new AiProviderError('UNAVAILABLE', `The AI provider returned ${status}.`, detailOf(err));
    return new AiProviderError('BAD_REQUEST', `The AI provider returned ${status}.`, detailOf(err));
  }
  // Output that failed the SDK's schema parse lands here.
  return new AiProviderError('INVALID_OUTPUT', 'The AI response could not be parsed.');
}

export function createAnthropicProvider(config: Pick<AiConfig, 'apiKey' | 'baseURL' | 'model' | 'timeoutMs'>, client?: Anthropic): AiProvider {
  // Retries are owned by the job runner (bounded, with backoff), so the SDK must not retry too.
  // An explicit apiKey stops the SDK reading any other credential from the environment or disk, and an
  // explicit baseURL (AiCredits) overrides ANTHROPIC_BASE_URL, so only this key goes to this host.
  const anthropic =
    client ?? new Anthropic({ apiKey: config.apiKey, ...(config.baseURL ? { baseURL: config.baseURL } : {}), maxRetries: 0, timeout: config.timeoutMs });
  const model = config.model;
  const fallback = FALLBACK_MODELS.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : { betas: [] };
  // Classification-style task: low effort keeps cost and latency down (where the model accepts it).
  const effort = NO_EFFORT_MODEL.test(model) ? {} : { effort: 'low' as const };

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
          output_config: { ...effort, format: betaZodOutputFormat(opts.schema) },
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

  /**
   * Bounded tool-calling loop. The model may call the given read-only tools, then must finish with
   * `final`, whose input is validated against its schema (invalid input is sent back as a tool error
   * so the model can correct it). Limits: maxTurns model calls, MAX_CALLS_PER_TURN tool calls per
   * turn, an overall deadline, and no SDK retries (the job runner owns retries).
   */
  async function runAgent<S extends z.ZodType>(input: AgentRunInput<S>): Promise<AgentResult<z.infer<S>>> {
    const started = Date.now();
    const byName = new Map(input.tools.map((t) => [t.name, t]));
    for (const name of [...byName.keys(), input.final.name]) {
      if (!TOOL_NAME.test(name)) throw new Error(`Invalid agent tool name: ${name}`);
    }
    const tools = [...input.tools.map((t) => toolDef(t.name, t.description, t.input)), toolDef(input.final.name, input.final.description, input.final.schema)];
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: input.userMessage }];
    const steps: AgentStep[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let servedModel = model;
    let nudged = false;

    for (let turn = 1; turn <= input.maxTurns; turn++) {
      const remaining = input.deadlineMs - (Date.now() - started);
      if (remaining < 1_000) throw new AiProviderError('TIMEOUT', 'The AI agent ran out of time.');
      let response;
      try {
        response = await anthropic.beta.messages.create(
          {
            model,
            max_tokens: 4096,
            ...fallback,
            ...(effort.effort ? { output_config: effort } : {}),
            system: input.system,
            tools,
            tool_choice: { type: 'auto' },
            messages,
          },
          { timeout: Math.min(config.timeoutMs, remaining), maxRetries: 0 },
        );
      } catch (err) {
        throw toProviderError(err);
      }
      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;
      servedModel = response.model;
      if (response.stop_reason === 'refusal') throw new AiProviderError('REFUSED', 'The AI provider declined to analyse this content.');
      if (response.stop_reason === 'max_tokens') throw new AiProviderError('INVALID_OUTPUT', 'The AI response was cut off.');
      messages.push({ role: 'assistant', content: response.content });

      const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (calls.length === 0) {
        // One reminder, then give up: the run must end in a validated recommendation.
        if (nudged) throw new AiProviderError('INVALID_OUTPUT', 'The AI agent stopped without a recommendation.');
        nudged = true;
        messages.push({ role: 'user', content: `Call ${input.final.name} now with your recommendation.` });
        continue;
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      const fail = (id: string, text: string) => results.push({ type: 'tool_result', tool_use_id: id, is_error: true, content: text });
      for (const [i, call] of calls.entries()) {
        if (i >= MAX_CALLS_PER_TURN) {
          fail(call.id, `At most ${MAX_CALLS_PER_TURN} tool calls are answered per turn.`);
          continue;
        }
        if (call.name === input.final.name) {
          const parsed = input.final.schema.safeParse(call.input);
          steps.push({ tool: call.name, ok: parsed.success, ms: 0 });
          if (parsed.success) {
            return {
              output: parsed.data,
              steps,
              turns: turn,
              meta: { provider: 'anthropic', model: servedModel, promptVersion: input.promptVersion, latencyMs: Date.now() - started, inputTokens, outputTokens },
            };
          }
          fail(call.id, `Invalid arguments: ${issuesOf(parsed.error)}. Fix them and call ${input.final.name} again.`);
          continue;
        }
        const tool = byName.get(call.name);
        if (!tool) {
          steps.push({ tool: 'unknown_tool', ok: false, ms: 0 });
          fail(call.id, 'Unknown tool.');
          continue;
        }
        const args = tool.input.safeParse(call.input);
        if (!args.success) {
          steps.push({ tool: tool.name, ok: false, ms: 0 });
          fail(call.id, `Invalid arguments: ${issuesOf(args.error)}`);
          continue;
        }
        const t0 = Date.now();
        try {
          const out = JSON.stringify(await tool.run(args.data)) ?? 'null';
          steps.push({ tool: tool.name, ok: true, ms: Date.now() - t0 });
          results.push({ type: 'tool_result', tool_use_id: call.id, content: out.length > MAX_TOOL_RESULT_CHARS ? `${out.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated)` : out });
        } catch {
          // Internal errors stay in our logs; the model only learns that the tool failed.
          steps.push({ tool: tool.name, ok: false, ms: Date.now() - t0 });
          fail(call.id, 'The tool failed. Continue without it.');
        }
      }
      messages.push({ role: 'user', content: results });
    }
    throw new AiProviderError('INVALID_OUTPUT', 'The AI agent did not finish within its step limit.');
  }

  return {
    name: 'anthropic',
    model,
    enabled: true,
    runAgent,
    compareResolution(input: ResolutionComparisonInput): Promise<AiResult<ResolutionComparison>> {
      const image = (img: ResolutionComparisonInput['after']): Anthropic.Beta.BetaContentBlockParam => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
      return call({
        system: COMPARE_SYSTEM,
        content: [
          { type: 'text', text: input.before.length > 0 ? `BEFORE photos (${input.before.length}), from the citizen's report:` : 'There is no BEFORE photo.' },
          ...input.before.map(image),
          { type: 'text', text: 'AFTER photo, submitted by the field team as proof of the fix:' },
          image(input.after),
          { type: 'text', text: compareUserMessage(input) },
        ],
        schema: resolutionComparisonSchema,
        promptVersion: COMPARE_PROMPT_VERSION,
      });
    },
    detectPrivacyRegions(image: ImageData): Promise<AiResult<PrivacyRegions>> {
      return call({
        system: PRIVACY_SYSTEM,
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
          { type: 'text', text: 'Locate faces and vehicle number plates in this image.' },
        ],
        schema: privacyRegionsSchema,
        promptVersion: PRIVACY_PROMPT_VERSION,
      });
    },
    classifyComplaint(input: ClassificationInput): Promise<AiResult<ClassificationOutput>> {
      return call({
        system: CLASSIFY_SYSTEM,
        content: classifyUserMessage({ ...input }),
        schema: classificationOutputSchema(input.departments.map((d) => d.ref)),
        promptVersion: CLASSIFY_PROMPT_VERSION,
      });
    },
    assessVideo(input: VideoAssessmentInput): Promise<AiResult<ImageAssessment>> {
      return call({
        system: VIDEO_SYSTEM,
        content: [
          { type: 'text', text: `${input.frames.length} frames from one video lasting ${input.durationSec.toFixed(1)} s, in time order:` },
          ...input.frames.flatMap((f): Anthropic.Beta.BetaContentBlockParam[] => [
            { type: 'text', text: `Frame at ${f.atSec.toFixed(1)} s:` },
            { type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.base64 } },
          ]),
          { type: 'text', text: imageUserMessage(input) },
        ],
        schema: imageAssessmentSchema,
        promptVersion: VIDEO_PROMPT_VERSION,
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
