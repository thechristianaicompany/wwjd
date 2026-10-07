import { timingSafeEqual } from 'node:crypto';
import type * as Engine from '@wwjd/engine';
import type * as Corpus from '@wwjd/corpus';

export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const RETENTION = 'Not stored by this self-hosted instance.';

export interface Env {
  OPENAI_API_KEY?: string;
  OWNER_KEY?: string;
  ALLOW_PUBLIC?: string;
  CF_VERSION_METADATA?: { id: string };
}

interface Dependencies {
  decide: typeof Engine.decide;
  createDecisionsClient: typeof Engine.createDecisionsClient;
  corpus: typeof Corpus;
  engineVersion: string;
  promptVersion: string;
}

class RequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function sameKey(provided: string, expected: string): Promise<boolean> {
  // Hash to fixed-size buffers, then use the runtime's constant-time comparison.
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
}

async function readInput(request: Request): Promise<Engine.DecideInput> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new RequestError(400, 'invalid_request', 'Use Content-Type: application/json.');
  }
  const length = request.headers.get('content-length');
  if (length && Number(length) > MAX_BODY_BYTES) {
    throw new RequestError(413, 'input_too_large', 'The request body must be at most 8 MB.');
  }
  if (!request.body) throw new RequestError(400, 'invalid_request', 'Send a JSON action and optional context.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RequestError(413, 'input_too_large', 'The request body must be at most 8 MB.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RequestError(400, 'invalid_request', 'Send valid UTF-8 JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new RequestError(400, 'invalid_request', 'Send a JSON object with an action.');
  }
  const body = data as Record<string, unknown>;
  if (typeof body.action !== 'string' || !body.action.trim() ||
      (body.context !== undefined && typeof body.context !== 'string')) {
    throw new RequestError(400, 'invalid_request', 'action must be a non-empty string; context must be a string.');
  }
  const action = body.action.trim();
  const context = body.context as string | undefined;
  if (Math.ceil((action.length + (context?.length ?? 0)) / 4) > 1_000_000) {
    throw new RequestError(413, 'input_too_large', 'The action and context must fit within 1,000,000 estimated tokens.');
  }
  return context === undefined ? { action } : { action, context };
}

function mappedError(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'input_too_large': return new RequestError(413, 'input_too_large', 'The input is too large for this decision.');
    case 'invalid_input': return new RequestError(400, 'invalid_request', 'The action or context is invalid.');
    case 'upstream_rate_limited': return new RequestError(503, 'service_unavailable', 'The evaluation provider is busy. Retry later.');
    case 'upstream_timeout': return new RequestError(504, 'upstream_timeout', 'The evaluation timed out. Retry later.');
    default: return new RequestError(502, 'upstream_error', 'The evaluation provider could not complete this decision.');
  }
}

export function createHandler(dependencies: Dependencies) {
  return async function fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const path = new URL(request.url).pathname;
    const known = path === '/v1/wwjd' || path === '/v1/health';
    const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-WWJD-Request-Id': requestId });
    if (known) headers.set('Access-Control-Allow-Origin', '*');
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    try {
      if (!known) throw new RequestError(404, 'not_found', 'This instance exposes /v1/wwjd and /v1/health.');
      if (request.method === 'OPTIONS') {
        headers.set('Access-Control-Allow-Methods', path === '/v1/wwjd' ? 'POST, OPTIONS' : 'GET, OPTIONS');
        headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        return new Response(null, { status: 204, headers });
      }
      if (path === '/v1/health') {
        if (request.method !== 'GET') throw new RequestError(405, 'method_not_allowed', 'Use GET /v1/health.');
        return json({
          ok: true, engine_version: dependencies.engineVersion, prompt_version: dependencies.promptVersion,
          corpus_version: dependencies.corpus.corpusVersion, model: 'gpt-6-luna', environment: 'selfhost',
          version_id: env.CF_VERSION_METADATA?.id ?? 'local',
        });
      }
      if (request.method !== 'POST') throw new RequestError(405, 'method_not_allowed', 'Use POST /v1/wwjd.');
      if (env.ALLOW_PUBLIC !== 'true') {
        if (!env.OWNER_KEY?.trim()) {
          throw new RequestError(503, 'owner_key_required', 'Set OWNER_KEY before using this instance.');
        }
        const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '');
        if (!match || !await sameKey(match[1]!, env.OWNER_KEY)) {
          throw new RequestError(401, 'unauthorized', 'Use this instance\'s OWNER_KEY as the bearer token (WWJD_API_KEY).');
        }
      }
      const input = await readInput(request);
      if (!env.OPENAI_API_KEY?.trim()) {
        throw new RequestError(503, 'service_unavailable', 'The instance owner must set OPENAI_API_KEY.');
      }
      const { decision } = await dependencies.decide(input, {
        decisionsClient: dependencies.createDecisionsClient({ apiKey: env.OPENAI_API_KEY }),
        corpus: dependencies.corpus,
      });
      // The engine trace stays in memory and is never returned or persisted.
      return json({ ...decision, retention: RETENTION });
    } catch (error) {
      const mapped = mappedError(error);
      if (mapped.status === 503 && error && typeof error === 'object' && 'retryAfterS' in error &&
          typeof error.retryAfterS === 'number' && Number.isFinite(error.retryAfterS) && error.retryAfterS > 0) {
        headers.set('Retry-After', String(Math.ceil(error.retryAfterS)));
      }
      return json({ error: { code: mapped.code, message: mapped.message } }, mapped.status);
    }
  };
}
