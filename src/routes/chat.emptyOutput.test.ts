/**
 * Zero-output guard + anomaly observability tests (selective port of
 * upstream issue #64 — UNIT_C/D/E only, adapted; no MAX_INLINE or
 * upload-fallback changes).
 *
 * All tests are local/synthetic: no network, no production state.
 * Anomaly records go to a tmp file via QWEN_ANOMALY_FILE.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { logStore } from '../services/logStore.ts';
import { handleAnthropicStream } from './anthropic.ts';
import { handleNonStreamingRequest } from './chatNonStreaming.ts';
import { handlePostStreamCompletion } from './streamLoop.ts';

let anomalyDir = '';
let anomalyFile = '';
function readAnomalies(): Array<Record<string, unknown>> {
  try {
    return readFileSync(anomalyFile, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

beforeEach(() => {
  anomalyDir = mkdtempSync(join(tmpdir(), 'qg-empty-'));
  anomalyFile = join(anomalyDir, 'anomalies.jsonl');
  process.env.QWEN_ANOMALY_FILE = anomalyFile;
});
afterEach(() => {
  delete process.env.QWEN_ANOMALY_FILE;
  rmSync(anomalyDir, { recursive: true, force: true });
});

function newLogId(model = 'qwen3-max', stream = true): string {
  const id = `empty-test-${Math.random().toString(36).slice(2)}`;
  logStore.createEntry(id, model, stream);
  return id;
}

function baseStreamState(overrides: Record<string, unknown> = {}): any {
  return {
    targetResponseId: null,
    nextParentId: null,
    completionTokens: 0,
    promptTokens: 10,
    currentThoughtIndex: 0,
    reasoningBuffer: '',
    lastFullContent: '',
    lastRawContent: '',
    lastFilteredSnapshot: '',
    lastThinkingSnapshot: '',
    lastVStrRaw: '',
    lastFilteredFullContent: '',
    lastDeltaThinkingFull: '',
    loggedToolCalls: new Set<string>(),
    lastParsePosition: 0,
    toolCallDepth: 0,
    pendingChunk: '',
    hasEmittedContent: false,
    answerChunkCount: 0,
    nonEmptyAnswerCount: 0,
    reasoningChunkCount: 0,
    ...overrides,
  };
}

function capturingWriter() {
  const writes: string[] = [];
  return {
    writes,
    writer: {
      write: async (s: string) => {
        writes.push(s);
      },
    },
  };
}

const noSessionPool = { release: () => {} };

async function runStreamCompletion(state: any, logId: string, buffer = '') {
  const { writes, writer } = capturingWriter();
  await handlePostStreamCompletion(
    {
      streamWriter: writer,
      completionId: 'chatcmpl-test',
      model: 'qwen3-max',
      streamState: state,
      ampState: { rawInputBytes: 100, emittedOutputBytes: 0, triggered: false },
      logId,
      resolvedEmail: 'op@test',
      emittedToolCallCount: 0,
      buffer,
      enableContentFiltering: false,
      includeUsage: false,
    },
    {
      reader: null as any,
      heartbeatInterval: null,
      chatId: `test-fake-${Math.random().toString(36).slice(2)}`,
      sessionHeaders: {},
      email: 'op@test',
      sessionPool: noSessionPool as any,
    },
  );
  return writes;
}

// ── Synthetic Qwen SSE stream for the non-streaming path ──────────────

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
}
const answerLine = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { phase: 'answer', content } }] })}\n\n`;
const thinkLine = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { phase: 'think', content } }] })}\n\n`;

async function runNonStream(lines: string[]) {
  const logId = newLogId('qwen3-max', false);
  let captured: { obj: any; status: number } | null = null;
  const ctx: any = {
    c: {
      json: (obj: any, status = 200) => {
        captured = { obj, status };
        return new Response('captured');
      },
    },
    logId,
    completionId: 'chatcmpl-test-ns',
    body: { model: 'qwen3-max', messages: [{ role: 'user', content: 'hi' }] },
    session: { chatId: `test-fake-${Math.random().toString(36).slice(2)}`, parentId: null, cachedHeaders: {}, accountEmail: 'op@test' },
    stream: sseStream(lines),
    resolvedEmail: 'op@test',
    initialParentId: null,
    sessionHeaders: {},
    toolCalling: true,
    cleanOutput: false,
  };
  await handleNonStreamingRequest(ctx);
  return { captured: captured!, logId };
}

async function runAnthropicStream(lines: string[]) {
  const logId = newLogId('qwen3-max', true);
  const app = new Hono();
  app.get('/', (c) =>
    handleAnthropicStream(
      c,
      'claude-sonnet-4-20250514',
      logId,
      { chatId: `test-fake-${Math.random().toString(36).slice(2)}`, parentId: null, cachedHeaders: {}, accountEmail: 'op@test' },
      sseStream(lines),
      new AbortController(),
      'op@test',
      null,
      {},
      10,
    ),
  );
  const response = await app.request('/');
  return { body: await response.text(), logId };
}

// ── STREAM ────────────────────────────────────────────────────────────

describe('streaming zero-output guard (UNIT_C)', () => {
  test('1. STREAM_EMPTY: empty upstream → error signal, no silent success', async () => {
    const logId = newLogId();
    const writes = await runStreamCompletion(baseStreamState(), logId);
    const joined = writes.join('\n');
    expect(joined).toContain('empty_upstream_response');
    expect(joined).toContain('data: [DONE]');
    // No content chunks emitted
    expect(writes.filter((w) => w.includes('"content"')).length).toBe(0);
    const entry = logStore.getEntry(logId);
    expect(entry?.finalResponse?.finishReason).toBe('empty_upstream_response');
    const anomalies = readAnomalies();
    expect(anomalies.length).toBe(1);
    expect(anomalies[0].type).toBe('empty_upstream');
  });

  test('4. STREAM_TOOL_ONLY: valid tool call exempts the guard', async () => {
    const logId = newLogId();
    const writes = await runStreamCompletion(
      baseStreamState({
        lastFullContent: '<function=Bash><parameter=command>hostname</parameter></function>',
        lastRawContent: '<function=Bash><parameter=command>hostname</parameter></function>',
        hasEmittedContent: true,
      }),
      logId,
    );
    const joined = writes.join('\n');
    expect(joined).not.toContain('empty_upstream_response');
    expect(joined).toContain('"finish_reason":"tool_calls"');
    expect(readAnomalies().length).toBe(0);
  });

  test('7/8. REASONING_ONLY and NORMAL_TEXT pass through', async () => {
    for (const state of [
      baseStreamState({ reasoningBuffer: 'some thinking' }),
      baseStreamState({ lastFullContent: 'Hello world', lastRawContent: 'Hello world' }),
    ]) {
      const logId = newLogId();
      const writes = await runStreamCompletion(state, logId);
      expect(writes.join('\n')).not.toContain('empty_upstream_response');
    }
    expect(readAnomalies().length).toBe(0);
  });

  test('10/11. UPSTREAM_ERROR_EMPTY: classified error wins over the guard', async () => {
    const logId = newLogId();
    const buffer = JSON.stringify({ success: false, data: { code: 'quota_limit', details: 'no capacity' } });
    const writes = await runStreamCompletion(baseStreamState(), logId, buffer);
    const joined = writes.join('\n');
    expect(joined).not.toContain('empty_upstream_response');
    const entry = logStore.getEntry(logId);
    expect(entry?.finalResponse?.finishReason).toBe('upstream_error');
  });

  test('12. POST_CONTENT_ERROR: yes + upstream error keeps existing behavior + short_then_error anomaly', async () => {
    const logId = newLogId();
    const buffer = JSON.stringify({ success: false, data: { code: 'internal_error', details: 'boom' } });
    const writes = await runStreamCompletion(
      baseStreamState({ lastFullContent: 'yes', lastRawContent: 'yes', hasEmittedContent: true }),
      logId,
      buffer,
    );
    const joined = writes.join('\n');
    // Existing post-content behavior: finish stop, no [Error] text appended
    expect(joined).toContain('"finish_reason":"stop"');
    expect(joined).not.toContain('[Error]');
    const anomalies = readAnomalies();
    expect(anomalies.length).toBe(1);
    expect(anomalies[0].type).toBe('short_then_error');
    expect(anomalies[0].upstreamErrorAfterContent).toBe(true);
    expect(anomalies[0].gateFinalPreview).toBe('yes');
  });

  test('YES_ONLY detector records without changing the wire', async () => {
    const logId = newLogId();
    const writes = await runStreamCompletion(
      baseStreamState({ lastFullContent: '  Yes ', lastRawContent: '  Yes ', hasEmittedContent: true }),
      logId,
    );
    const joined = writes.join('\n');
    expect(joined).not.toContain('empty_upstream_response');
    expect(joined).toContain('"finish_reason":"stop"');
    const anomalies = readAnomalies();
    expect(anomalies.length).toBe(1);
    expect(anomalies[0].type).toBe('yes_only');
  });

  test('NORMAL_SHORT_TEXT "yes, hostname is quant" is not yes_only', async () => {
    const logId = newLogId();
    await runStreamCompletion(
      baseStreamState({ lastFullContent: 'yes, hostname is quant', lastRawContent: 'yes, hostname is quant' }),
      logId,
    );
    expect(readAnomalies().length).toBe(0);
  });
});

// ── NON-STREAM ────────────────────────────────────────────────────────

describe('non-streaming zero-output guard (UNIT_D)', () => {
  test('2. NONSTREAM_EMPTY: empty upstream → 502 empty_upstream_response', async () => {
    const { captured } = await runNonStream([`data: ${JSON.stringify({ usage: { output_tokens: 0 } })}\n\n`]);
    expect(captured.status).toBe(502);
    expect(captured.obj.error.code).toBe('empty_upstream_response');
    const anomalies = readAnomalies();
    expect(anomalies.length).toBe(1);
    expect(anomalies[0].type).toBe('empty_upstream');
  });

  test('5. NONSTREAM_TOOL_ONLY: tool call exempts the guard', async () => {
    const { captured } = await runNonStream([answerLine('run <function=Bash><parameter=command>hostname</parameter></function>')]);
    expect(captured.status).toBe(200);
    expect(captured.obj.choices[0].finish_reason).toBe('tool_calls');
    expect(captured.obj.choices[0].message.tool_calls.length).toBeGreaterThan(0);
    expect(readAnomalies().length).toBe(0);
  });

  test('7/8/9. REASONING_ONLY, REASONING_PLUS_ANSWER, NORMAL_TEXT unchanged', async () => {
    const r1 = await runNonStream([thinkLine('hmm')]);
    expect(r1.captured.status).toBe(200);
    expect(r1.captured.obj.choices[0].message.reasoning_content).toContain('hmm');
    const r2 = await runNonStream([thinkLine('hmm'), answerLine('done')]);
    expect(r2.captured.status).toBe(200);
    expect(r2.captured.obj.choices[0].message.content).toContain('done');
    const r3 = await runNonStream([answerLine('Hello world')]);
    expect(r3.captured.status).toBe(200);
    expect(r3.captured.obj.choices[0].finish_reason).toBe('stop');
    expect(readAnomalies().length).toBe(0);
  });

  test('10/11. classified upstream error wins (quota_limit tail envelope)', async () => {
    const envelope = JSON.stringify({ success: false, data: { code: 'quota_limit', details: 'no capacity' } });
    const { captured } = await runNonStream([answerLine(''), `data: ${envelope}`]);
    expect(captured.status).toBe(502);
    expect(JSON.stringify(captured.obj)).toContain('quota_limit');
    expect(JSON.stringify(captured.obj)).not.toContain('empty_upstream_response');
  });

  test('12a. yes + tail error envelope → error wins + short_then_error anomaly', async () => {
    const envelope = JSON.stringify({ success: false, data: { code: 'internal_error', details: 'boom' } });
    const { captured } = await runNonStream([answerLine('yes'), `data: ${envelope}`]);
    expect(captured.status).toBe(502);
    const anomalies = readAnomalies();
    expect(anomalies.length).toBe(1);
    expect(anomalies[0].type).toBe('short_then_error');
    expect(anomalies[0].gateFinalPreview).toBe('yes');
  });

  test('12b. yes + consumed error line preserves error precedence', async () => {
    const { captured } = await runNonStream([answerLine('yes'), `data: ${JSON.stringify({ error: 'boom' })}\n\n`]);
    expect(captured.status).toBe(502);
    expect(captured.obj.error.code).toBe('UpstreamError');
    const anomalies = readAnomalies();
    expect(anomalies.length).toBe(1);
    expect(anomalies[0].type).toBe('short_then_error');
  });

  test('NONSTREAM yes_only detector records without changing the response', async () => {
    const { captured } = await runNonStream([answerLine('YES')]);
    expect(captured.status).toBe(200);
    const anomalies = readAnomalies();
    expect(anomalies.length).toBe(1);
    expect(anomalies[0].type).toBe('yes_only');
  });
});

// ── FASE 11: EOF remainder documented as known issue ──────────────────

describe('EOF remainder (known issue, NOT fixed)', () => {
  test('unterminated tail line is dropped by the non-streaming parser', async () => {
    const full = answerLine('hello tail').trimEnd(); // no trailing newline
    const { captured } = await runNonStream([full]);
    // Current behavior: remainder without newline never parses → empty guard fires
    expect(captured.status).toBe(502);
    expect(captured.obj.error.code).toBe('empty_upstream_response');
  });
});

describe('phaseless OpenAI-compatible content', () => {
  test('non-streaming path preserves content deltas without phase', async () => {
    const phaseless = `data: ${JSON.stringify({ choices: [{ delta: { content: 'phaseless-text' } }] })}\n\n`;
    const { captured } = await runNonStream([phaseless]);
    expect(captured.status).toBe(200);
    expect(captured.obj.choices[0].message.content).toBe('phaseless-text');
    expect(readAnomalies().length).toBe(0);
  });

  test('non-streaming path does not reclassify consumed delta errors as empty', async () => {
    const deltaError = `data: ${JSON.stringify({ choices: [{ delta: { status: 'error', message: 'boom' } }] })}\n\n`;
    const { captured } = await runNonStream([deltaError]);
    expect(captured.status).toBe(502);
    expect(captured.obj.error.code).toBe('UpstreamError');
    expect(JSON.stringify(captured.obj)).not.toContain('empty_upstream_response');
    expect(readAnomalies().length).toBe(0);
  });
});

describe('Anthropic streaming terminal signals', () => {
  test('clean empty upstream emits Anthropic error without end_turn', async () => {
    const { body, logId } = await runAnthropicStream(['data: [DONE]\n\n']);
    expect(body).toContain('event: error');
    expect(body).toContain('empty_upstream_response');
    expect(body).not.toContain('event: message_delta');
    expect(logStore.getEntry(logId)?.finalResponse?.finishReason).toBe('empty_upstream_response');
    expect(readAnomalies().map((a) => a.type)).toEqual(['empty_upstream']);
  });

  test('yes-only remains a normal Anthropic response and records one anomaly', async () => {
    const { body } = await runAnthropicStream([answerLine('yes'), 'data: [DONE]\n\n']);
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: message_delta');
    expect(body).toContain('"stop_reason":"end_turn"');
    expect(readAnomalies().map((a) => a.type)).toEqual(['yes_only']);
  });

  test('yes followed by explicit error emits error and only short_then_error', async () => {
    const envelope = `data: ${JSON.stringify({ success: false, data: { code: 'internal_error', details: 'boom' } })}\n\n`;
    const { body } = await runAnthropicStream([answerLine('yes'), envelope, 'data: [DONE]\n\n']);
    expect(body).toContain('event: error');
    expect(body).toContain('internal_error');
    expect(body).not.toContain('event: message_delta');
    expect(readAnomalies().map((a) => a.type)).toEqual(['short_then_error']);
  });
});
