/**
 * Local-model grading, proven without Ollama: the grade is a pure function of
 * the facts Ollama reports, so the thresholds that decide what a user is told
 * are pinned here.
 */
import assert from 'node:assert/strict';
import {
  gradeOllamaModel,
  isOllamaModel,
  localRunEnv,
  localRunOptions,
  ollamaEnv,
  ollamaName,
  OLLAMA_APP,
  OLLAMA_PREFIX,
  pickOllamaLauncher,
} from '../src/agent/ollama';
import { localAnswer, rewriteLocalRequest } from '../src/agent/ollamaProxy';

let passed = 0;
const failures: [string, Error][] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push([name, err as Error]);
    console.log(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

console.log('\nlocal model grading');

test('no tool calling is unfit — Claude Code cannot drive it', () => {
  const g = gradeOllamaModel({ name: 'llama2:7b', capabilities: ['completion'], paramsB: 7, contextK: 4 });
  assert.equal(g.quality, 'unfit');
  assert.match(g.note, /tool calling/);
});

test('an 8B model with tools is weak — the measured case', () => {
  const g = gradeOllamaModel({ name: 'qwen3:8b', capabilities: ['tools', 'thinking'], paramsB: 8.2, contextK: 40 });
  assert.equal(g.quality, 'weak');
  assert.match(g.note, /Too small/);
});

test('a small context caps the grade even for a big model', () => {
  const g = gradeOllamaModel({ name: 'big-short', capabilities: ['tools'], paramsB: 70, contextK: 8 });
  assert.equal(g.quality, 'weak');
  assert.match(g.note, /32k/);
});

test('14–30B with tools is fair', () => {
  const g = gradeOllamaModel({ name: 'gpt-oss:20b', capabilities: ['tools'], paramsB: 20.9, contextK: 128 });
  assert.equal(g.quality, 'fair');
  assert.match(g.note, /not recommended for teams/);
});

test('30B+ with tools and room to think is strong', () => {
  const g = gradeOllamaModel({ name: 'qwen3-coder:30b', capabilities: ['tools'], paramsB: 30.5, contextK: 256 });
  assert.equal(g.quality, 'strong');
});

test('unknown size with tools is not punished — graded strong with the caveat in the note', () => {
  const g = gradeOllamaModel({ name: 'mystery', capabilities: ['tools'], paramsB: null, contextK: null });
  assert.equal(g.quality, 'strong');
});

console.log('\nthe ollama/ address');

test('local models are addressed with a prefix and stripped for the runtime', () => {
  assert.ok(isOllamaModel(`${OLLAMA_PREFIX}qwen3:8b`));
  assert.ok(!isOllamaModel('claude-opus-5'));
  assert.ok(!isOllamaModel(''));
  assert.equal(ollamaName(`${OLLAMA_PREFIX}qwen3:8b`), 'qwen3:8b');
});

test('the redirect env points Claude Code at Ollama and blanks the real key', () => {
  const env = ollamaEnv();
  assert.match(env.ANTHROPIC_BASE_URL, /11434/);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'ollama');
  assert.equal(env.ANTHROPIC_API_KEY, '');
});

console.log('\nstarting ollama for the user');

test('prefers the app, then the CLI, then nothing to launch', () => {
  assert.equal(pickOllamaLauncher((p) => p === OLLAMA_APP, 'darwin')?.how, 'app');
  assert.equal(pickOllamaLauncher((p) => p === '/opt/homebrew/bin/ollama', 'darwin')?.how, 'cli');
  assert.equal(pickOllamaLauncher(() => false, 'darwin'), null);
});

test('the app opens in the background so airoom keeps focus', () => {
  assert.deepEqual(pickOllamaLauncher((p) => p === OLLAMA_APP, 'darwin')?.args, ['-g', '-a', 'Ollama']);
  assert.deepEqual(pickOllamaLauncher((p) => p === '/usr/local/bin/ollama', 'darwin')?.args, ['serve']);
});

console.log('\na run a small model can carry');

test('local runs replace the 33k agent prompt with a short one and six core tools', () => {
  const o = localRunOptions('weak', '/w/proj');
  assert.ok(o.systemPrompt.includes('/w/proj'));
  assert.ok(o.systemPrompt.length < 1200, `prompt is ${o.systemPrompt.length} chars`);
  assert.match(o.systemPrompt, /without using any tool/);
  assert.deepEqual(o.tools, ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep']);
});

test('thinking is off below the strong tier and left alone at it', () => {
  assert.deepEqual(localRunOptions('weak', '/w').thinking, { type: 'disabled' });
  assert.deepEqual(localRunOptions('fair', '/w').thinking, { type: 'disabled' });
  assert.deepEqual(localRunOptions(undefined, '/w').thinking, { type: 'disabled' });
  assert.equal(localRunOptions('strong', '/w').thinking, undefined);
});

test('the local env redirects to Ollama and quiets side traffic', () => {
  const e = localRunEnv('qwen3:8b');
  assert.match(e.ANTHROPIC_BASE_URL, /11434/);
  assert.equal(e.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(e.CLAUDE_CODE_SUBAGENT_MODEL, 'qwen3:8b');
});

test('when airoom starts the CLI server it asks for a 32k window; the app keeps its own setting', () => {
  assert.equal(pickOllamaLauncher((p) => p === '/opt/homebrew/bin/ollama', 'darwin')?.env?.OLLAMA_CONTEXT_LENGTH, '32768');
  assert.equal(pickOllamaLauncher((p) => p === OLLAMA_APP, 'darwin')?.env, undefined);
});

console.log('\nthe relay between Claude Code and Ollama');

const weakOnly = (m: string) => (m === 'qwen3:8b' ? 'disabled' : null) as 'disabled' | null;

test('below strong, a /v1/messages request without thinking gets it disabled', () => {
  const out = rewriteLocalRequest('/v1/messages?beta=true', { model: 'qwen3:8b', messages: [] }, weakOnly) as Record<string, unknown>;
  assert.deepEqual(out.thinking, { type: 'disabled' });
});

test('a strong model, an explicit thinking field, and other paths pass through untouched', () => {
  const strong = { model: 'qwen3-coder:30b', messages: [] };
  assert.equal(rewriteLocalRequest('/v1/messages', strong, weakOnly), strong);
  const explicit = { model: 'qwen3:8b', thinking: { type: 'enabled', budget_tokens: 512 } };
  assert.equal(rewriteLocalRequest('/v1/messages', explicit, weakOnly), explicit);
  const count = { model: 'qwen3:8b' };
  assert.equal(rewriteLocalRequest('/v1/messages/count_tokens?beta=true', count, weakOnly), count);
});

test('token-count probes are answered locally so they never reach the runner', () => {
  const count = localAnswer('/v1/messages/count_tokens?beta=true', { model: 'qwen3:8b', messages: [{ role: 'user', content: 'x'.repeat(400) }] });
  assert.equal(count?.status, 200);
  assert.ok((count?.json as { input_tokens: number }).input_tokens >= 100);
  const probe = localAnswer('/v1/messages', { model: 'qwen3:8b', max_tokens: 1, messages: [{ role: 'user', content: 'count' }] });
  assert.equal((probe?.json as { stop_reason: string }).stop_reason, 'max_tokens');
  const streamed = localAnswer('/v1/messages', { model: 'qwen3:8b', max_tokens: 1, stream: true, messages: [] });
  assert.match(streamed?.sse ?? '', /event: message_start[\s\S]*event: message_stop/);
});

test('a real turn is not answered locally', () => {
  assert.equal(localAnswer('/v1/messages', { model: 'qwen3:8b', max_tokens: 32000, messages: [{ role: 'user', content: 'hello' }] }), null);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
