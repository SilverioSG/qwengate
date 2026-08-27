import assert from 'node:assert';
import test from 'node:test';
import { validateOpenAIRequest } from '../utils/validation.ts';
import { buildFeatureConfig, resolveThinkingMode } from './qwen.ts';

function thinkingFields(mode: 'fast' | 'auto' | 'thinking') {
  const config = buildFeatureConfig(mode);
  return {
    thinking_enabled: config.thinking_enabled,
    auto_thinking: config.auto_thinking,
    thinking_mode: config.thinking_mode,
    thinking_format: config.thinking_format,
  };
}

test('buildFeatureConfig: fast mapping', () => {
  assert.deepStrictEqual(thinkingFields('fast'), {
    thinking_enabled: false,
    auto_thinking: false,
    thinking_mode: 'Fast',
    thinking_format: 'summary',
  });
});

test('buildFeatureConfig: auto mapping', () => {
  assert.deepStrictEqual(thinkingFields('auto'), {
    thinking_enabled: true,
    auto_thinking: true,
    thinking_mode: 'Auto',
    thinking_format: 'summary',
  });
});

test('buildFeatureConfig: thinking mapping', () => {
  assert.deepStrictEqual(thinkingFields('thinking'), {
    thinking_enabled: true,
    auto_thinking: false,
    thinking_mode: 'Thinking',
    thinking_format: 'summary',
  });
});

test('resolveThinkingMode: agentic default is fast', () => {
  assert.strictEqual(resolveThinkingMode(undefined, undefined, true), 'fast');
});

test('resolveThinkingMode: non-agentic default is auto', () => {
  assert.strictEqual(resolveThinkingMode(undefined, undefined, false), 'auto');
});

test('resolveThinkingMode: explicit mode overrides defaults', () => {
  assert.strictEqual(resolveThinkingMode('thinking', undefined, true), 'thinking');
  assert.strictEqual(resolveThinkingMode('auto', undefined, true), 'auto');
  assert.strictEqual(resolveThinkingMode('fast', undefined, false), 'fast');
});

test('resolveThinkingMode: enableThinking compatibility', () => {
  assert.strictEqual(resolveThinkingMode(undefined, true, true), 'thinking');
  assert.strictEqual(resolveThinkingMode(undefined, false, false), 'fast');
  assert.strictEqual(buildFeatureConfig(true).thinking_mode, 'Thinking');
  assert.strictEqual(buildFeatureConfig(false).thinking_mode, 'Fast');
});

test('resolveThinkingMode: legacy no-thinking model defaults to fast', () => {
  assert.strictEqual(resolveThinkingMode(undefined, undefined, false, true), 'fast');
  assert.strictEqual(resolveThinkingMode('auto', undefined, false, true), 'auto');
});

test('buildQwenMessages: applies thinking defaults and explicit override', async () => {
  const { buildQwenMessages } = await import('../routes/chatHelpers.ts');
  const tools = [{ type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: {} } } }];
  const messages = [{ role: 'user', content: 'hello' }];

  const agentic = buildQwenMessages(messages, { model: 'qwen3.7-max', tools }, 100000, true);
  assert.strictEqual(agentic.qwenMessages[0].feature_config.thinking_mode, 'Fast');

  const nonAgentic = buildQwenMessages(messages, { model: 'qwen3.7-max' }, 100000, true);
  assert.strictEqual(nonAgentic.qwenMessages[0].feature_config.thinking_mode, 'Auto');

  const override = buildQwenMessages(messages, { model: 'qwen3.7-max', tools, thinking_mode: 'thinking' }, 100000, true);
  assert.strictEqual(override.qwenMessages[0].feature_config.thinking_mode, 'Thinking');
});

test('validation: accepts thinking_mode and enableThinking request fields', () => {
  const result = validateOpenAIRequest({
    model: 'qwen3.7-max',
    messages: [{ role: 'user', content: 'hello' }],
    thinking_mode: 'auto',
    enableThinking: true,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data?.thinking_mode, 'auto');
  assert.strictEqual(result.data?.enableThinking, true);
});
