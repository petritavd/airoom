/**
 * A loopback relay between Claude Code and Ollama.
 *
 * Claude Code speaks the Anthropic API to whatever ANTHROPIC_BASE_URL names.
 * Pointing it at airoom instead of straight at Ollama costs one hop on the
 * loopback interface and buys the one knob the runtime does not expose: when
 * thinking is off, Claude Code simply omits the `thinking` field, and Ollama
 * then falls back to the model's default — which for qwen3 and friends is to
 * think at length. Measured on qwen3:8b: a greeting is 65–125 output tokens
 * with thinking, 24 without; a tool call 4.5s versus 0.8–2.6s. So for models
 * below the strong tier the relay writes `thinking: {type: 'disabled'}` into
 * every /v1/messages request that does not set it. Everything else — headers,
 * status, the SSE stream — passes through untouched.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export const OLLAMA_PROXY_PREFIX = '/ollama';

export type ThinkingPolicy = (model: string) => 'disabled' | null;

/** The one rewrite, kept pure so it can be pinned by a test. */
export function rewriteLocalRequest(path: string, body: unknown, policy: ThinkingPolicy): unknown {
  if (!/\/v1\/messages(\?|$)/.test(path)) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  if (b.thinking !== undefined) return body;
  const model = typeof b.model === 'string' ? b.model : '';
  return policy(model) === 'disabled' ? { ...b, thinking: { type: 'disabled' } } : body;
}

/**
 * Requests the relay answers itself, never forwarding.
 *
 * Claude Code keeps its context meter honest by counting tokens: first via
 * /v1/messages/count_tokens (which Ollama answers 404), then by falling back
 * to `max_tokens: 1` probes — a bare "count", the system prompt alone, the
 * full tool set. Measured: six probes for two turns. Each one is a prefill
 * on the only runner there is, and each evicts the prompt cache, so the real
 * request that follows pays the full prefill again. A chars/4 estimate is
 * what those numbers are for — a meter — so answer with that and let Ollama
 * see nothing but real turns.
 */
export function localAnswer(path: string, body: unknown): { status: number; json?: unknown; sse?: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const tokens = estimateTokens(b);
  if (/\/v1\/messages\/count_tokens(\?|$)/.test(path)) return { status: 200, json: { input_tokens: tokens } };
  if (/\/v1\/messages(\?|$)/.test(path) && b.max_tokens === 1) {
    const model = typeof b.model === 'string' ? b.model : 'local';
    const message = {
      id: `msg_airoom_${Date.now().toString(36)}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: '' }],
      stop_reason: 'max_tokens',
      stop_sequence: null,
      usage: { input_tokens: tokens, output_tokens: 1 },
    };
    if (b.stream !== true) return { status: 200, json: message };
    const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    const sse =
      ev('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: tokens, output_tokens: 0 } } }) +
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 1 } }) +
      ev('message_stop', { type: 'message_stop' });
    return { status: 200, sse };
  }
  return null;
}

/** Roughly four characters per token — the meter's precision, not billing's. */
export function estimateTokens(b: Record<string, unknown>): number {
  const size = JSON.stringify({ system: b.system ?? '', messages: b.messages ?? [], tools: b.tools ?? [] }).length;
  return Math.max(1, Math.ceil(size / 4));
}

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'accept-encoding']);

/**
 * Relay one request. Returns false (having written nothing) when the URL is
 * not under the proxy prefix, so the caller's other routes still run.
 */
export function relayToOllama(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: string,
  policy: ThinkingPolicy,
): boolean {
  const url = req.url ?? '';
  if (url !== OLLAMA_PROXY_PREFIX && !url.startsWith(OLLAMA_PROXY_PREFIX + '/')) return false;
  const path = url.slice(OLLAMA_PROXY_PREFIX.length) || '/';
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('error', () => fail(res, 502, 'airoom relay: request body failed'));
  req.on('end', () => {
    let body: Buffer | string = Buffer.concat(chunks);
    if (body.length && req.method === 'POST') {
      try {
        const parsed = JSON.parse(body.toString('utf8')) as unknown;
        const local = localAnswer(path, parsed);
        if (local) {
          if (local.sse !== undefined) {
            res.writeHead(local.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            res.end(local.sse);
          } else {
            res.writeHead(local.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(local.json));
          }
          return;
        }
        const next = rewriteLocalRequest(path, parsed, policy);
        if (next !== parsed) body = JSON.stringify(next);
      } catch {
        /* not JSON — forward as is */
      }
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k) || v == null) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    const init: RequestInit = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = typeof body === 'string' ? body : new Uint8Array(body);
    fetch(upstream + path, init)
      .then((up) => {
        const out: Record<string, string> = {};
        up.headers.forEach((v, k) => {
          if (!HOP_BY_HOP.has(k)) out[k] = v;
        });
        res.writeHead(up.status, out);
        if (!up.body) return void res.end();
        const stream = Readable.fromWeb(up.body as import('node:stream/web').ReadableStream);
        stream.on('error', () => res.end());
        stream.pipe(res);
      })
      .catch((err: unknown) => {
        fail(res, 502, `airoom relay: Ollama did not answer at ${upstream} (${(err as Error).message ?? err})`);
      });
  });
  return true;
}

function fail(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
}
