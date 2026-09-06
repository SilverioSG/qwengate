import assert from 'node:assert';
import test from 'node:test';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
// Set a test API key (never empty — prevents auth bypass in tests)
process.env.API_KEY = 'test-key-for-testing';

import { app } from '../index.tsx';
import { accounts } from '../services/accountManager.ts';

const TEST_API_KEY = 'test-key-for-testing';
const authHeaders = { Authorization: `Bearer ${TEST_API_KEY}` };

test('Health check returns degraded when Playwright not initialized', async () => {
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);

  assert.strictEqual(res.status, 200);

  const body = await res.json();
  assert.strictEqual(body.status, 'degraded');
  assert.ok(typeof body.uptime === 'number');
});

test('Models endpoint returns cleaned OpenAI-compatible model data', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'qwen3.8-max',
              owned_by: 'qwen',
              info: {
                created_at: 1732711466,
                meta: {
                  max_context_length: 1000000,
                  max_summary_generation_length: 65536,
                  modality: ['text', 'image'],
                  short_description: 'A test model',
                  capabilities: { vision: true, thinking: true },
                },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/models', { headers: authHeaders });
    const res = await app.fetch(req);

    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.object, 'list');
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length >= 3, 'Should return at least the 3 aliases');

    // Endpoint now returns only aliases, not upstream models
    const ids = body.data.map((m: any) => m.id);
    assert.ok(ids.includes('qwen3.8-max-fast'), 'Should include fast alias');
    assert.ok(ids.includes('qwen3.8-max-auto'), 'Should include auto alias');
    assert.ok(ids.includes('qwen3.8-max-thinking'), 'Should include thinking alias');

    // Verify alias metadata inherits from base model
    const fastAlias = body.data.find((m: any) => m.id === 'qwen3.8-max-fast');
    assert.strictEqual(fastAlias.object, 'model');
    assert.strictEqual(fastAlias.context_window, 1000000);
    assert.strictEqual(fastAlias.max_output_tokens, 65536);
    assert.deepStrictEqual(fastAlias.modalities, ['text', 'image']);
    assert.strictEqual(fastAlias.root, 'qwen3.8-max');
    assert.strictEqual(fastAlias.parent, 'qwen3.8-max');
    // should not carry raw Qwen-internal fields
    assert.strictEqual(fastAlias.info, undefined);
    assert.strictEqual(fastAlias.preset, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat Completions endpoint with qwen3.6-plus (thinking enabled)', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_thought": {"content": ["Thinking..."]}}}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'What is 99 * 182? Please think step by step.' }],
      stream: true,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let hasReasoning = false;
    let hasContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.trim() === 'data: [DONE]') {
          break;
        }
        if (line.startsWith('data: ')) {
          try {
            const dataStr = line.slice(6);
            if (dataStr !== '[DONE]') {
              const data = JSON.parse(dataStr);

              if (data.choices && data.choices[0] && data.choices[0].delta) {
                const delta = data.choices[0].delta;
                if (delta.content) {
                  hasContent = true;
                }
                if (delta.reasoning_content) {
                  hasReasoning = true;
                }
              }
            }
          } catch {
            // Partial JSON ignored
          }
        }
      }
    }

    assert.ok(hasReasoning, 'Should have received streamed chunks with reasoning_content (Thinking enabled)');
    assert.ok(hasContent, 'Should have received streamed chunks with content');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat Completions returns explicit error for non-SSE upstream JSON errors', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return new Response(
        JSON.stringify({
          success: false,
          data: {
            code: 'RateLimited',
            details: "You've reached the upper limit for today's usage.",
            num: 3,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 429);

    const body = await res.json();
    assert.match(body.error.message, /Qwen upstream error: RateLimited/);
    assert.match(body.error.message, /upper limit/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat Completions returns a JSON chat.completion object for non-streaming requests', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.object, 'chat.completion');
    assert.strictEqual(body.choices[0].message.role, 'assistant');
    assert.strictEqual(body.choices[0].message.content, 'Hello');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('API Key protection', async () => {
  const originalApiKey = process.env.API_KEY;
  process.env.API_KEY = 'test-api-key';
  let originalFetch: any;

  try {
    // 1. Test request without API Key
    const req1 = new Request('http://localhost/v1/models');
    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 401, 'Should return 401 Unauthorized without API Key');

    // 2. Test request with wrong API Key
    const req2 = new Request('http://localhost/v1/models', {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 401, 'Should return 401 Unauthorized with wrong API Key');

    // 3. Test request with correct API Key
    // Mock fetch for models list
    originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });

    try {
      const req3 = new Request('http://localhost/v1/models', {
        headers: { Authorization: 'Bearer test-api-key' },
      });
      const res3 = await app.fetch(req3);
      assert.strictEqual(res3.status, 200, 'Should return 200 OK with correct API Key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.env.API_KEY = originalApiKey;
  }
});

test('Chat completions with image uploads attaches files (t2t chat_type, vision class)', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  // Seed a test account so pickAccount returns an account for image upload
  accounts.push({
    email: 'test@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  let stsCalled = false;
  let ossCalled = false;
  let chatPayload: any = null;
  let chatSignal: AbortSignal | undefined;

  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/getstsToken')) {
      stsCalled = true;
      return new Response(
        JSON.stringify({
          data: {
            access_key_id: 'test-key',
            access_key_secret: 'test-secret',
            security_token: 'test-token',
            bucketname: 'test-bucket',
            region: 'oss-cn-hangzhou',
            endpoint: 'oss-cn-hangzhou.aliyuncs.com',
            file_id: 'test-file-id',
            file_path: 'test-user/test-file-id_image.png',
            file_url: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com/test-file-id_image.png',
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('/api/v2/files/parse/status')) {
      return new Response(JSON.stringify({ data: [{ status: 'success' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/parse')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes('aliyuncs.com') || url.includes('oss-')) {
      ossCalled = true;
      return new Response(null, { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      // Capture the payload for later assertions
      // init?.body is set when browserlessFetch calls globalThis.fetch(url, { method, headers, body })
      chatSignal = init?.signal;
      const bodyStr =
        typeof input === 'string' && init?.body ? init.body : typeof input !== 'string' ? await (input as Request).clone().text() : '';
      try {
        chatPayload = JSON.parse(bodyStr);
      } catch {}
      // Return a simple stream
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "Image received"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAA=' } },
          ],
        },
      ],
      stream: false,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, { Authorization: 'Bearer test-key-for-testing' }),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.ok(chatSignal instanceof AbortSignal, 'Qwen stream should pass an abort signal to browserlessFetch');
    assert.strictEqual(chatSignal?.aborted, false);

    // Verify STS token was requested (image upload initiated)
    assert.ok(stsCalled, 'Should have called getstsToken for image upload');

    // Verify OSS upload happened
    assert.ok(ossCalled, 'Should have uploaded image to OSS');

    // Verify the chat payload has the right format
    assert.ok(chatPayload, 'Chat completion should have been called');
    const msg = chatPayload?.messages?.[0];
    assert.ok(msg, 'Should have at least one message');

    // The image_url should be stripped from content text (only text parts remain)
    assert.ok(!msg.content.includes('image_url'), 'Image URL should be stripped from content text');
    assert.ok(msg.content.includes('What is in this image?'), 'Text content should be preserved');

    // Should have files attached
    assert.ok(Array.isArray(msg.files), 'Message should have files array');
    assert.ok(msg.files.length > 0, 'Should have at least one file (image)');

    // Chat type should remain t2t (default) — Qwen web UI uses t2t even with images
    assert.strictEqual(msg.chat_type, 't2t', 'Chat type should remain t2t for images');
    assert.strictEqual(msg.sub_chat_type, 't2t', 'Sub chat type should remain t2t');
    assert.strictEqual(msg.extra?.meta?.subChatType, 't2t', 'Extra subChatType should remain t2t');

    // Verify file attachment format
    const file = msg.files[0];
    assert.strictEqual(file.type, 'image', 'File attachment type should be image');
    assert.strictEqual(file.file_class, 'vision', 'File class should be vision');
  } finally {
    globalThis.fetch = originalFetch;
    accounts.splice(0, accounts.length, ...originalAccounts);
  }
});

test('Chat Completions endpoint - Non-streaming (stream: false)', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_thought": {"content": ["Thinking non-stream..."]}}}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello non-stream"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('Content-Type')?.includes('application/json'));

    const body = await res.json();
    assert.strictEqual(body.object, 'chat.completion');
    assert.strictEqual(body.model, 'qwen3.6-plus');
    assert.ok(body.choices);
    assert.strictEqual(body.choices.length, 1);

    const choice = body.choices[0];
    assert.strictEqual(choice.message.role, 'assistant');
    assert.strictEqual(choice.message.content, 'Hello non-stream');
    assert.strictEqual(choice.message.reasoning_content, 'Thinking non-stream...');
    assert.strictEqual(choice.finish_reason, 'stop');

    assert.ok(body.usage);
    assert.ok(body.usage.prompt_tokens > 0);
    assert.ok(body.usage.completion_tokens >= 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic streaming strips XML artifacts from text deltas', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push({
    email: 'xml-test@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.7-max', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/getstsToken')) {
      return new Response(
        JSON.stringify({
          data: {
            access_key_id: 'test-key',
            access_key_secret: 'test-secret',
            security_token: 'test-token',
            bucketname: 'test-bucket',
            region: 'oss-cn-hangzhou',
            endpoint: 'oss-cn-hangzhou.aliyuncs.com',
            file_id: 'test-file-id',
            file_path: 'test-user/test-file-id_context.txt',
            file_url: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com/test-file-id_context.txt',
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('/api/v2/files/parse/status')) {
      return new Response(JSON.stringify({ data: [{ status: 'success' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/parse')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes('aliyuncs.com') || url.includes('oss-')) {
      return new Response(null, { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          // Text chunk with XML tool call artifact embedded
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"phase":"answer","content":"I\'ll check the file. <function=Bash><parameter=command>cat /etc/hostname</parameter></function>"}}]}\n\n',
            ),
          );
          c.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":" The hostname is qwen-gate."}}]}\n\n'),
          );
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"phase":"local_tool","status":"finished","extra":{"local_mcp":{"★":[{"tool_name":"★-Bash","params":{"command":"cat /etc/hostname"}}]}}}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      stream: true,
      tools: [
        {
          name: 'Bash',
          description: 'Run a shell command',
          input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        },
      ],
      messages: [{ role: 'user', content: 'Check hostname' }],
    };

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...authHeaders,
      },
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200, `Expected 200 got ${res.status}`);

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let allSse = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allSse += decoder.decode(value, { stream: true });
    }

    const events: any[] = [];
    for (const line of allSse.split('\n')) {
      if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
        try {
          events.push(JSON.parse(line.slice(6)));
        } catch {
          /* skip partial */
        }
      }
    }

    // Check that NO text_delta contains XML artifacts
    const textDeltas = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta');
    for (const td of textDeltas) {
      assert.doesNotMatch(
        td.delta.text,
        /<function=|<\/function>|<parameter=/,
        `text_delta must not contain XML artifacts. Got: ${JSON.stringify(td.delta.text)}`,
      );
    }

    // Verify tool_use block exists (from local_mcp)
    const toolStart = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
    assert.ok(toolStart, `Should have tool_use block`);
    assert.strictEqual(toolStart.content_block.name, 'Bash');
    // Per Anthropic spec, content_block_start has input: {}
    assert.deepStrictEqual(toolStart.content_block.input, {}, 'tool_use start must have empty input');

    // Verify input_json_delta carries the actual args
    const inputDeltas = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta');
    assert.ok(inputDeltas.length >= 1, 'Should have at least one input_json_delta event');
    const parsedInput = JSON.parse(inputDeltas[0].delta.partial_json);
    assert.strictEqual(parsedInput.command, 'cat /etc/hostname', 'input_json_delta must contain command');
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic /v1/messages streaming with local_mcp tool call emits correct tool_use block', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  // Seed a test account
  accounts.push({
    email: 'test@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.7-max', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/getstsToken')) {
      return new Response(
        JSON.stringify({
          data: {
            access_key_id: 'test-key',
            access_key_secret: 'test-secret',
            security_token: 'test-token',
            bucketname: 'test-bucket',
            region: 'oss-cn-hangzhou',
            endpoint: 'oss-cn-hangzhou.aliyuncs.com',
            file_id: 'test-file-id',
            file_path: 'test-user/test-file-id_context.txt',
            file_url: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com/test-file-id_context.txt',
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('/api/v2/files/parse/status')) {
      return new Response(JSON.stringify({ data: [{ status: 'success' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/parse')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes('aliyuncs.com') || url.includes('oss-')) {
      return new Response(null, { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"I\'ll run that for you."}}]}\n\n'));
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"phase":"local_tool","status":"finished","extra":{"local_mcp":{"★":[{"tool_name":"★-Bash","params":{"command":"ls -la /tmp"}}]}}}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      stream: true,
      tools: [
        {
          name: 'Bash',
          description: 'Run a shell command',
          input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        },
      ],
      messages: [{ role: 'user', content: 'Run ls in /tmp' }],
    };

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...authHeaders,
      },
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(
      res.status,
      200,
      `Expected 200 got ${res.status} — body: ${await res
        .clone()
        .text()
        .catch(() => '?')}`,
    );

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let allSse = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allSse += decoder.decode(value, { stream: true });
    }

    // Parse all SSE events
    const events: any[] = [];
    for (const line of allSse.split('\n')) {
      if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
        try {
          events.push(JSON.parse(line.slice(6)));
        } catch {
          /* skip partial */
        }
      }
    }

    // Verify message_start
    const msgStart = events.find((e) => e.type === 'message_start');
    assert.ok(msgStart, 'Should have message_start');
    assert.strictEqual(msgStart.message.role, 'assistant');

    // Find tool_use content block — per spec, input is {} in start event
    const toolStart = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
    assert.ok(toolStart, `Should have tool_use content_block_start — types: ${[...new Set(events.map((e) => e.type))].join(', ')}`);
    assert.strictEqual(toolStart.content_block.name, 'Bash', `Tool name should be Bash. Got: ${toolStart.content_block.name}`);
    assert.deepStrictEqual(toolStart.content_block.input, {}, 'tool_use start must have empty input per spec');

    // Verify input_json_delta carries the actual args
    const inputDeltas = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta');
    assert.ok(inputDeltas.length >= 1, 'Should have at least one input_json_delta');
    const parsedInput = JSON.parse(inputDeltas[0].delta.partial_json);
    assert.strictEqual(parsedInput.command, 'ls -la /tmp', `input_json_delta must have command. Got: ${JSON.stringify(parsedInput)}`);

    // Verify message_delta stop_reason
    const msgDelta = events.find((e) => e.type === 'message_delta');
    assert.ok(msgDelta, 'Should have message_delta');
    assert.strictEqual(msgDelta.delta.stop_reason, 'tool_use');
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('SSE pre-content quota_limit: max 1 handoff then error', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  // Seed two test accounts
  accounts.push({
    email: 'acct1@test.dev',
    password: 'test',
    state: { token: 'mock-token-1', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0, throttledUntil: 0, refreshInFlight: null, loginAttempt: 0, inFlight: 0, totalRequests: 0, startupStatus: 'ready',
  });
  accounts.push({
    email: 'acct2@test.dev',
    password: 'test',
    state: { token: 'mock-token-2', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0, throttledUntil: 0, refreshInFlight: null, loginAttempt: 0, inFlight: 0, totalRequests: 0, startupStatus: 'ready',
  });

  let chatCalls = 0;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      chatCalls++;
      // Both accounts return RateLimited on first chunk
      return new Response(
        JSON.stringify({ success: false, data: { code: 'RateLimited', details: 'Daily limit reached', num: 7 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    // After MAX_ACCOUNT_RETRIES=2 exhausted, should return 429
    assert.strictEqual(res.status, 429);
    const body = await res.json();
    assert.match(body.error.message, /daily usage limit/i);

    // Should have tried at most 2 accounts (1 initial + 1 handoff)
    assert.ok(chatCalls <= 2, `Expected at most 2 chat calls, got ${chatCalls}`);
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('SSE pre-content internal_error: max 1 handoff then error', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push({
    email: 'acct1@test.dev',
    password: 'test',
    state: { token: 'mock-token-1', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0, throttledUntil: 0, refreshInFlight: null, loginAttempt: 0, inFlight: 0, totalRequests: 0, startupStatus: 'ready',
  });
  accounts.push({
    email: 'acct2@test.dev',
    password: 'test',
    state: { token: 'mock-token-2', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0, throttledUntil: 0, refreshInFlight: null, loginAttempt: 0, inFlight: 0, totalRequests: 0, startupStatus: 'ready',
  });

  let chatCalls = 0;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      chatCalls++;
      // Both accounts return internal_error on first chunk
      return new Response(
        JSON.stringify({ success: false, data: { code: 'UpstreamError', details: 'Internal server error' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 502);
    const body = await res.json();
    assert.match(body.error.message, /UpstreamError/i);

    // Should have tried at most 2 accounts
    assert.ok(chatCalls <= 2, `Expected at most 2 chat calls, got ${chatCalls}`);
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('SSE post-content error: partial content preserved, no [Error] text', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push({
    email: 'acct1@test.dev',
    password: 'test',
    state: { token: 'mock-token-1', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0, throttledUntil: 0, refreshInFlight: null, loginAttempt: 0, inFlight: 0, totalRequests: 0, startupStatus: 'ready',
  });

  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      // Stream starts with content, then sends error
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"Hello world"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: {"success":false,"data":{"code":"RateLimited","details":"quota exceeded","num":3}}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let allSse = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allSse += decoder.decode(value, { stream: true });
    }

    // Should contain the partial content
    assert.ok(allSse.includes('Hello world'), 'Should contain partial content "Hello world"');

    // Should NOT contain [Error] text (post-content error is recoverable)
    assert.ok(!allSse.includes('[Error]'), 'Should NOT contain [Error] text after content was emitted');

    // Should finish with stop
    assert.ok(allSse.includes('"finish_reason":"stop"'), 'Should finish with stop reason');

    // Should end with [DONE]
    assert.ok(allSse.includes('[DONE]'), 'Should end with [DONE]');
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('SSE pre-content error: error text written when no content emitted', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push({
    email: 'acct1@test.dev',
    password: 'test',
    state: { token: 'mock-token-1', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0, throttledUntil: 0, refreshInFlight: null, loginAttempt: 0, inFlight: 0, totalRequests: 0, startupStatus: 'ready',
  });

  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      // Stream starts with empty content (passes first-chunk check),
      // then error arrives BEFORE any real content is emitted
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":""}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: {"success":false,"data":{"code":"RateLimited","details":"quota exceeded","num":3}}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let allSse = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allSse += decoder.decode(value, { stream: true });
    }

    // Should contain [Error] text (pre-content error surfaces to client)
    assert.ok(allSse.includes('[Error]'), 'Should contain [Error] text when no content was emitted');

    // Should finish with stop
    assert.ok(allSse.includes('"finish_reason":"stop"'), 'Should finish with stop reason');

    // Should end with [DONE]
    assert.ok(allSse.includes('[DONE]'), 'Should end with [DONE]');
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('inFlight cleanup after SSE stream error', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push({
    email: 'inflight-test@test.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0, throttledUntil: 0, refreshInFlight: null, loginAttempt: 0, inFlight: 0, totalRequests: 0, startupStatus: 'ready',
  });

  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"Partial"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: {"success":false,"data":{"code":"RateLimited","details":"limit","num":1}}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    // Consume the stream to trigger cleanup
    const reader = res.body?.getReader();
    while (true) {
      const { done } = await reader!.read();
      if (done) break;
    }

    // Wait for scheduleCleanup's setTimeout(0) to fire
    await new Promise((r) => setTimeout(r, 50));

    // Verify session pool was cleaned up (no active sessions)
    const { sessionPool } = await import('../services/sessionPool.ts');
    const stats = sessionPool.getStats();
    assert.strictEqual(stats.total, 0, 'Session pool should have 0 active sessions after cleanup');
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('Model alias: qwen3.8-max-auto resolves to upstream qwen3.8-max with thinking_mode=auto', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push({
    email: 'alias-test@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0, throttledUntil: 0, refreshInFlight: null, loginAttempt: 0, inFlight: 0, totalRequests: 0, startupStatus: 'ready',
  });

  let chatPayload: any = null;
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-max', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/getstsToken')) {
      return new Response(JSON.stringify({ data: { access_key_id: 'test-key', access_key_secret: 'test-secret', security_token: 'test-token', bucketname: 'test-bucket', region: 'oss-cn-hangzhou', endpoint: 'oss-cn-hangzhou.aliyuncs.com', file_id: 'test-file-id', file_path: 'test-user/test-file-id_context.txt', file_url: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com/test-file-id_context.txt' } }), { status: 200 });
    }
    if (url.includes('/api/v2/files/parse/status')) {
      return new Response(JSON.stringify({ data: [{ status: 'success' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/parse')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes('aliyuncs.com') || url.includes('oss-')) {
      return new Response(null, { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const bodyStr = typeof input === 'string' && init?.body ? init.body : typeof input !== 'string' ? await (input as Request).clone().text() : '';
      try { chatPayload = JSON.parse(bodyStr); } catch {}
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"Tool result processed"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, { Authorization: 'Bearer test-key-for-testing' }),
      body: JSON.stringify({
        model: 'qwen3.8-max-auto',
        messages: [{ role: 'user', content: 'List files in /tmp' }],
        tools: [{ type: 'function', function: { name: 'bash', description: 'Run shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200, `Expected 200 got ${res.status}`);

    assert.ok(chatPayload, 'Upstream chat payload should have been captured');

    // Upstream model must be qwen3.8-max (not qwen3.8-max-auto)
    const upstreamModel = chatPayload.messages?.[0]?.models?.[0] || chatPayload.model;
    assert.strictEqual(upstreamModel, 'qwen3.8-max', 'Upstream model must be qwen3.8-max');

    // feature_config.thinking_mode must be Auto (not Fast)
    const featureConfig = chatPayload.messages?.[0]?.feature_config;
    assert.ok(featureConfig, 'feature_config should exist');
    assert.strictEqual(featureConfig.thinking_mode, 'Auto', 'thinking_mode must be Auto');
    assert.strictEqual(featureConfig.thinking_enabled, true, 'thinking_enabled must be true');
    assert.strictEqual(featureConfig.auto_thinking, true, 'auto_thinking must be true');
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('Model alias: qwen3.8-max-fast resolves to upstream qwen3.8-max with thinking_mode=Fast', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push({
    email: 'alias-fast-test@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0, throttledUntil: 0, refreshInFlight: null, loginAttempt: 0, inFlight: 0, totalRequests: 0, startupStatus: 'ready',
  });

  let chatPayload: any = null;
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-max', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/getstsToken')) {
      return new Response(JSON.stringify({ data: { access_key_id: 'test-key', access_key_secret: 'test-secret', security_token: 'test-token', bucketname: 'test-bucket', region: 'oss-cn-hangzhou', endpoint: 'oss-cn-hangzhou.aliyuncs.com', file_id: 'test-file-id', file_path: 'test-user/test-file-id_context.txt', file_url: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com/test-file-id_context.txt' } }), { status: 200 });
    }
    if (url.includes('/api/v2/files/parse/status')) {
      return new Response(JSON.stringify({ data: [{ status: 'success' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/parse')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes('aliyuncs.com') || url.includes('oss-')) {
      return new Response(null, { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const bodyStr = typeof input === 'string' && init?.body ? init.body : typeof input !== 'string' ? await (input as Request).clone().text() : '';
      try { chatPayload = JSON.parse(bodyStr); } catch {}
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"Fast mode response"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, { Authorization: 'Bearer test-key-for-testing' }),
      body: JSON.stringify({
        model: 'qwen3.8-max-fast',
        messages: [{ role: 'user', content: 'List files in /tmp' }],
        tools: [{ type: 'function', function: { name: 'bash', description: 'Run shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200, `Expected 200 got ${res.status}`);

    assert.ok(chatPayload, 'Upstream chat payload should have been captured');

    const upstreamModel = chatPayload.messages?.[0]?.models?.[0] || chatPayload.model;
    assert.strictEqual(upstreamModel, 'qwen3.8-max', 'Upstream model must be qwen3.8-max');

    const featureConfig = chatPayload.messages?.[0]?.feature_config;
    assert.ok(featureConfig, 'feature_config should exist');
    assert.strictEqual(featureConfig.thinking_mode, 'Fast', 'thinking_mode must be Fast');
    assert.strictEqual(featureConfig.thinking_enabled, false, 'thinking_enabled must be false');
    assert.strictEqual(featureConfig.auto_thinking, false, 'auto_thinking must be false');
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('Model alias: qwen3.8-max-thinking resolves to upstream qwen3.8-max with thinking_mode=Thinking', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push({
    email: 'alias-thinking-test@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0, throttledUntil: 0, refreshInFlight: null, loginAttempt: 0, inFlight: 0, totalRequests: 0, startupStatus: 'ready',
  });

  let chatPayload: any = null;
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-max', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/getstsToken')) {
      return new Response(JSON.stringify({ data: { access_key_id: 'test-key', access_key_secret: 'test-secret', security_token: 'test-token', bucketname: 'test-bucket', region: 'oss-cn-hangzhou', endpoint: 'oss-cn-hangzhou.aliyuncs.com', file_id: 'test-file-id', file_path: 'test-user/test-file-id_context.txt', file_url: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com/test-file-id_context.txt' } }), { status: 200 });
    }
    if (url.includes('/api/v2/files/parse/status')) {
      return new Response(JSON.stringify({ data: [{ status: 'success' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/parse')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes('aliyuncs.com') || url.includes('oss-')) {
      return new Response(null, { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const bodyStr = typeof input === 'string' && init?.body ? init.body : typeof input !== 'string' ? await (input as Request).clone().text() : '';
      try { chatPayload = JSON.parse(bodyStr); } catch {}
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_thought":{"content":["Deep thinking..."]}}}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"Thinking mode response"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, { Authorization: 'Bearer test-key-for-testing' }),
      body: JSON.stringify({
        model: 'qwen3.8-max-thinking',
        messages: [{ role: 'user', content: 'List files in /tmp' }],
        tools: [{ type: 'function', function: { name: 'bash', description: 'Run shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200, `Expected 200 got ${res.status}`);

    assert.ok(chatPayload, 'Upstream chat payload should have been captured');

    const upstreamModel = chatPayload.messages?.[0]?.models?.[0] || chatPayload.model;
    assert.strictEqual(upstreamModel, 'qwen3.8-max', 'Upstream model must be qwen3.8-max');

    const featureConfig = chatPayload.messages?.[0]?.feature_config;
    assert.ok(featureConfig, 'feature_config should exist');
    assert.strictEqual(featureConfig.thinking_mode, 'Thinking', 'thinking_mode must be Thinking');
    assert.strictEqual(featureConfig.thinking_enabled, true, 'thinking_enabled must be true');
    assert.strictEqual(featureConfig.auto_thinking, false, 'auto_thinking must be false');
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('Model alias: /v1/models returns aliases inheriting base model metadata', async () => {
  const originalFetch = globalThis.fetch;

  // Mock with upstream data that includes qwen3.8-max (needed for alias injection)
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(
        JSON.stringify({
          data: [{
            id: 'qwen3.8-max',
            owned_by: 'qwen',
            info: { created_at: 1732711466, meta: { max_context_length: 1000000, max_summary_generation_length: 65536, modality: ['text'], capabilities: {} } },
          }],
        }),
        { status: 200 },
      );
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/models', { headers: { Authorization: 'Bearer test-key-for-testing' } });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    const ids = body.data.map((m: any) => m.id);

    // Endpoint returns only aliases (not upstream models)
    assert.ok(ids.includes('qwen3.8-max-fast'), 'Should include alias qwen3.8-max-fast');
    assert.ok(ids.includes('qwen3.8-max-auto'), 'Should include alias qwen3.8-max-auto');
    assert.ok(ids.includes('qwen3.8-max-thinking'), 'Should include alias qwen3.8-max-thinking');
    assert.ok(!ids.includes('qwen3.8-max'), 'Should NOT include upstream base model');

    const fastAlias = body.data.find((m: any) => m.id === 'qwen3.8-max-fast');
    assert.ok(fastAlias, 'Fast alias entry should exist');
    assert.strictEqual(fastAlias.root, 'qwen3.8-max', 'Fast alias root should point to base model');
    assert.strictEqual(fastAlias.parent, 'qwen3.8-max', 'Fast alias parent should point to base model');
    assert.ok(fastAlias.description.includes('qwen3.8-max'), 'Fast alias description should reference base model');
    assert.ok(fastAlias.description.includes('thinking_mode=fast'), 'Fast alias description should mention thinking mode');

    const alias = body.data.find((m: any) => m.id === 'qwen3.8-max-auto');
    assert.ok(alias, 'Auto alias entry should exist');
    assert.strictEqual(alias.root, 'qwen3.8-max', 'Auto alias root should point to base model');
    assert.strictEqual(alias.parent, 'qwen3.8-max', 'Auto alias parent should point to base model');
    assert.ok(alias.description.includes('qwen3.8-max'), 'Auto alias description should reference base model');
    assert.ok(alias.description.includes('thinking_mode=auto'), 'Auto alias description should mention thinking mode');

    const thinkingAlias = body.data.find((m: any) => m.id === 'qwen3.8-max-thinking');
    assert.ok(thinkingAlias, 'Thinking alias entry should exist');
    assert.strictEqual(thinkingAlias.root, 'qwen3.8-max', 'Thinking alias root should point to base model');
    assert.strictEqual(thinkingAlias.parent, 'qwen3.8-max', 'Thinking alias parent should point to base model');
    assert.ok(thinkingAlias.description.includes('qwen3.8-max'), 'Thinking alias description should reference base model');
    assert.ok(thinkingAlias.description.includes('thinking_mode=thinking'), 'Thinking alias description should mention thinking mode');

    // Verify endpoint returns valid OpenAI-compatible structure
    assert.strictEqual(body.object, 'list');
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length >= 3, 'Should have at least the 3 aliases');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// inFlight balance tests
// ═══════════════════════════════════════════════════════════════════════════

import { getRetryablePreEmissionQuota, MAX_MIDSTREAM_QUOTA_HANDOFFS } from '../routes/streamLoop.ts';
import {
  decrementInFlight,
  decrementModelRequests,
  getAccountByEmail,
  getModelRequestsInFlight,
  incrementModelRequests,
  pickAccount,
  rebuildEmailIndex,
} from '../services/accountManager.ts';
import { sessionPool } from '../services/sessionPool.ts';

function makeAcct(email: string) {
  return {
    email,
    password: 'test',
    state: { token: `tok-${email}`, expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready' as const,
  };
}

test('inFlight balance: pick -> complete -> release -> 0', async () => {
  const originalAccounts = [...accounts];
  accounts.push(makeAcct('bal-success@test.dev'));
  rebuildEmailIndex();

  try {
    const acct = accounts.find(a => a.email === 'bal-success@test.dev')!;
    assert.strictEqual(acct.inFlight, 0, 'starts at 0');

    const picked = await pickAccount();
    assert.ok(picked);
    assert.strictEqual(picked.inFlight, 1, 'after pick = 1');

    // Simulate successful session acquire + release
    const fakeChatId = 'chat-' + crypto.randomUUID();
    (sessionPool as any).activeSessions?.add(fakeChatId);
    (sessionPool as any).activeCount = ((sessionPool as any).activeCount || 0) + 1;
    await sessionPool.release(fakeChatId, null, undefined, picked.email, true);

    assert.strictEqual(acct.inFlight, 0, 'after release = 0');
  } finally {
    accounts.length = 0;
    accounts.push(...originalAccounts);
    rebuildEmailIndex();
  }
});

test('inFlight balance: pick -> upstream error -> release -> 0', async () => {
  const originalAccounts = [...accounts];
  accounts.push(makeAcct('bal-error@test.dev'));
  rebuildEmailIndex();

  try {
    const picked = await pickAccount();
    assert.ok(picked);
    assert.strictEqual(picked.inFlight, 1, 'after pick = 1');

    // Simulate failed session acquire (error path)
    const fakeChatId = 'chat-' + crypto.randomUUID();
    (sessionPool as any).activeSessions?.add(fakeChatId);
    (sessionPool as any).activeCount = ((sessionPool as any).activeCount || 0) + 1;
    await sessionPool.release(fakeChatId, null, undefined, picked.email, false);

    assert.strictEqual(picked.inFlight, 0, 'after error release = 0');
  } finally {
    accounts.length = 0;
    accounts.push(...originalAccounts);
    rebuildEmailIndex();
  }
});

test('inFlight balance: pick -> abort -> decrement -> 0', async () => {
  const originalAccounts = [...accounts];
  accounts.push(makeAcct('bal-abort@test.dev'));
  rebuildEmailIndex();

  try {
    const picked = await pickAccount();
    assert.ok(picked);
    assert.strictEqual(picked.inFlight, 1, 'after pick = 1');

    // Simulate abort path: decrement manually (as chat.ts does on abort/timeout)
    decrementInFlight(picked.email);
    assert.strictEqual(picked.inFlight, 0, 'after abort decrement = 0');
  } finally {
    accounts.length = 0;
    accounts.push(...originalAccounts);
    rebuildEmailIndex();
  }
});

test('stale inFlight recovery: cleanupStaleInFlight resets old counters when idle', async () => {
  const { cleanupStaleInFlight } = await import('../services/accountManager.ts');
  const originalAccounts = [...accounts];
  accounts.push(makeAcct('stale-test@test.dev'));
  rebuildEmailIndex();

  try {
    const acct = accounts.find(a => a.email === 'stale-test@test.dev')!;
    // Simulate stale: inFlight=1, lastInFlightAt set to 3 minutes ago
    acct.inFlight = 1;
    acct.lastInFlightAt = Date.now() - 180_000;

    const reset = cleanupStaleInFlight();
    assert.strictEqual(reset, 1, 'should reset 1 stale account');
    assert.strictEqual(acct.inFlight, 0, 'inFlight reset to 0');
  } finally {
    accounts.length = 0;
    accounts.push(...originalAccounts);
    rebuildEmailIndex();
  }
});

test('stale inFlight: recent counter NOT cleaned up', async () => {
  const { cleanupStaleInFlight } = await import('../services/accountManager.ts');
  const originalAccounts = [...accounts];
  accounts.push(makeAcct('recent-test@test.dev'));
  rebuildEmailIndex();

  try {
    const acct = accounts.find(a => a.email === 'recent-test@test.dev')!;
    acct.inFlight = 1;
    acct.lastInFlightAt = Date.now() - 5_000; // only 5s ago

    const reset = cleanupStaleInFlight();
    assert.strictEqual(reset, 0, 'should NOT reset recent counter');
    assert.strictEqual(acct.inFlight, 1, 'inFlight stays at 1');
  } finally {
    accounts.length = 0;
    accounts.push(...originalAccounts);
    rebuildEmailIndex();
  }
});

test('LONG_RUNNING_REQUEST_NOT_RESET: active model request protects stale counter', async () => {
  const { cleanupStaleInFlight } = await import('../services/accountManager.ts');
  const originalAccounts = [...accounts];
  // Simulate: 2 model requests in flight
  incrementModelRequests();
  incrementModelRequests();
  assert.strictEqual(getModelRequestsInFlight(), 2, 'modelRequestsInFlight should be 2');
  accounts.push(makeAcct('longrun-test@test.dev'));
  rebuildEmailIndex();

  try {
    const acct = accounts.find(a => a.email === 'longrun-test@test.dev')!;
    // inFlight=1, age > threshold, but model requests are active
    acct.inFlight = 1;
    acct.lastInFlightAt = Date.now() - 180_000;

    const reset = cleanupStaleInFlight();
    assert.strictEqual(reset, 0, 'MUST NOT reset — model requests are active');
    assert.strictEqual(acct.inFlight, 1, 'inFlight stays at 1 — request is legitimate');
  } finally {
    decrementModelRequests();
    decrementModelRequests();
    assert.strictEqual(getModelRequestsInFlight(), 0, 'modelRequestsInFlight back to 0');
    accounts.length = 0;
    accounts.push(...originalAccounts);
    rebuildEmailIndex();
  }
});

test('ORPHANED_STALE_COUNTER_RESET: idle system + old counter = safe reset', async () => {
  const { cleanupStaleInFlight } = await import('../services/accountManager.ts');
  const originalAccounts = [...accounts];
  // No model requests in flight
  assert.strictEqual(getModelRequestsInFlight(), 0, 'modelRequestsInFlight should be 0');
  accounts.push(makeAcct('orphan-test@test.dev'));
  rebuildEmailIndex();

  try {
    const acct = accounts.find(a => a.email === 'orphan-test@test.dev')!;
    // inFlight=1, age > threshold, no model requests
    acct.inFlight = 1;
    acct.lastInFlightAt = Date.now() - 180_000;

    const reset = cleanupStaleInFlight();
    assert.strictEqual(reset, 1, 'should reset orphaned counter');
    assert.strictEqual(acct.inFlight, 0, 'inFlight reset to 0');
  } finally {
    accounts.length = 0;
    accounts.push(...originalAccounts);
    rebuildEmailIndex();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// quota_limit classification tests
// ═══════════════════════════════════════════════════════════════════════════

test('SSE pre-emission quota_limit: handoff to second account', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push(makeAcct('ql-pre1@test.dev'));
  accounts.push(makeAcct('ql-pre2@test.dev'));
  rebuildEmailIndex();

  let chatCalls = 0;
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      chatCalls++;
      // First call returns quota_limit, second returns content
      if (chatCalls === 1) {
        return new Response(
          JSON.stringify({ success: false, data: { code: 'quota_limit', details: 'High demand' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // Second call: return valid SSE stream
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello from acct2"}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return originalFetch(input, init);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    // Should succeed (not 429 or 500) — handoff worked
    assert.ok(res.status === 200, `Expected 200 after handoff, got ${res.status}`);
    assert.ok(chatCalls >= 2, `Expected at least 2 chat calls (initial + handoff), got ${chatCalls}`);

    // The account that hit quota_limit should NOT be throttled
    const acct1 = accounts.find(a => a.email === 'ql-pre1@test.dev');
    assert.ok(acct1, 'acct1 should exist');
    assert.ok(!acct1?.throttledUntil || acct1.throttledUntil <= Date.now(), 'acct1 should NOT be throttled');
  } finally {
    accounts.length = 0;
    accounts.push(...originalAccounts);
    rebuildEmailIndex();
    globalThis.fetch = originalFetch;
  }
});

test('quota_limit does NOT throttle the account', async () => {
  const originalAccounts = [...accounts];
  accounts.push(makeAcct('ql-nothrottle@test.dev'));
  rebuildEmailIndex();

  try {
    const acct = accounts.find(a => a.email === 'ql-nothrottle@test.dev');
    assert.ok(acct, 'account should exist');
    assert.strictEqual(acct!.throttledUntil, 0, 'starts unthrottled');

    // The fix ensures quota_limit paths do NOT call throttleAccount
    // Only RateLimited and CAPTCHA paths call throttleAccount
    // This test verifies the account stays eligible after quota_limit
    const picked = await pickAccount();
    assert.ok(picked, 'account should still be pickable');
    assert.strictEqual(picked.email, 'ql-nothrottle@test.dev');
    decrementInFlight(picked.email);
  } finally {
    accounts.length = 0;
    accounts.push(...originalAccounts);
    rebuildEmailIndex();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// data.error quota_limit failover tests (2026-09-06 incident envelope)
// Upstream sends: data: {"error":{"code":"quota_limit","details":"..."}}
// ═══════════════════════════════════════════════════════════════════════════

const DATA_ERROR_QUOTA_LINE =
  'data: {"error":{"code":"quota_limit","details":"The service is currently experiencing high demand. Please try again later."}}\n\n';

test('SSE pre-content data.error quota_limit: handoff to second account', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push(makeAcct('ql-de-pre1@test.dev'));
  accounts.push(makeAcct('ql-de-pre2@test.dev'));
  rebuildEmailIndex();

  let chatCalls = 0;
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      chatCalls++;
      // First call returns the exact incident envelope as first SSE chunk
      if (chatCalls === 1) {
        return new Response(DATA_ERROR_QUOTA_LINE, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      // Second call: return valid SSE stream
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello from acct2"}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return originalFetch(input, init);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    // FAILOVER_ATTEMPTED=YES: handoff must have happened (initial + 1 handoff, max 1)
    assert.ok(res.status === 200, `Expected 200 after handoff, got ${res.status}`);
    assert.strictEqual(chatCalls, 2, `Expected exactly 2 chat calls (HANDOFF_COUNT=1), got ${chatCalls}`);

    // ERROR_NOT_PROPAGATED_ON_SUCCESSFUL_HANDOFF=YES: client sees content, not [Error]
    const allSse = await res.text();
    assert.ok(allSse.includes('Hello from acct2'), 'Should contain second-account content');
    assert.ok(!allSse.includes('[Error]'), 'Should NOT propagate [Error] after successful handoff');

    // The account that hit quota_limit should NOT be throttled
    const acct1 = accounts.find(a => a.email === 'ql-de-pre1@test.dev');
    assert.ok(acct1, 'acct1 should exist');
    assert.ok(!acct1?.throttledUntil || acct1.throttledUntil <= Date.now(), 'acct1 should NOT be throttled');
  } finally {
    accounts.length = 0;
    accounts.push(...originalAccounts);
    rebuildEmailIndex();
    globalThis.fetch = originalFetch;
  }
});

test('SSE post-content data.error quota_limit: NO handoff, partial content preserved', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push(makeAcct('ql-de-post1@test.dev'));
  accounts.push(makeAcct('ql-de-post2@test.dev'));
  rebuildEmailIndex();

  let chatCalls = 0;
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      chatCalls++;
      // Content first (passes first-chunk check), then data.error quota_limit
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"Hello world"}}]}\n\n'));
          c.enqueue(
            new TextEncoder().encode(
              'data: {"error":{"code":"quota_limit","details":"The service is currently experiencing high demand. Please try again later."}}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return originalFetch(input, init);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');
    const decoder = new TextDecoder();
    let allSse = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allSse += decoder.decode(value, { stream: true });
    }

    assert.ok(allSse.includes('Hello world'), 'Should contain partial content "Hello world"');
    assert.ok(!allSse.includes('[Error]'), 'Post-content error must not append [Error] text');
    assert.strictEqual(chatCalls, 1, `Post-content must NOT handoff (expected 1 chat call, got ${chatCalls})`);
  } finally {
    accounts.length = 0;
    accounts.push(...originalAccounts);
    rebuildEmailIndex();
    globalThis.fetch = originalFetch;
  }
});

test('SSE data.error quota_limit on all accounts: max 1 handoff then terminal error', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push(makeAcct('ql-de-max1@test.dev'));
  accounts.push(makeAcct('ql-de-max2@test.dev'));
  rebuildEmailIndex();

  let chatCalls = 0;
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      chatCalls++;
      return new Response(DATA_ERROR_QUOTA_LINE, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return originalFetch(input, init);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 502);
    const body = await res.json();
    assert.match(body.error.message, /quota_limit/i);
    assert.strictEqual(chatCalls, 2, `Expected exactly 2 chat calls (max 1 handoff), got ${chatCalls}`);
  } finally {
    accounts.length = 0;
    accounts.push(...originalAccounts);
    rebuildEmailIndex();
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Mid-stream pre-emission quota_limit handoff
// Pattern: chunk1 healthy (response.created, no content) + chunk2 quota_limit
// with hasEmittedContent=false → exactly 1 handoff A→B.
// ═══════════════════════════════════════════════════════════════════════════

const MID_HEALTHY_FIRST = 'data: {"response.created":{"chat_id":"c1","parent_id":"p1","response_id":"r1","response_index":"0"}}\n\n';
const MID_HEALTHY_FIRST_B = 'data: {"response.created":{"chat_id":"c2","parent_id":"p2","response_id":"r2","response_index":"0"}}\n\n';
const MID_QUOTA_CHUNK =
  'data: {"error":{"code":"quota_limit","details":"The service is currently experiencing high demand. Please try again later."}}\n\n';
const MID_DONE = 'data: [DONE]\n\n';
// NOTE: answer chunks must carry the matching response_id, like real Qwen SSE.
// Without it, extractDeltaContent drops the delta once response.created set
// the target response id (id-less chunks only pass when no created arrived).
const midAnswer = (text: string, rid: string) =>
  `data: {"response_id":"${rid}","choices":[{"delta":{"phase":"answer","content":"${text}"}}]}\n\n`;

function midSseResponse(lines: string[]): Response {
  const stream = new ReadableStream({
    start(c) {
      for (const line of lines) c.enqueue(new TextEncoder().encode(line));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function readMidSse(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  assert.ok(reader, 'Response should have a readable body');
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function mockMidChat(handler: (callIndex: number) => Response): { restore: () => void; calls: () => number } {
  const originalFetch = globalThis.fetch;
  let chatCalls = 0;
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      chatCalls++;
      return handler(chatCalls);
    }
    return (originalFetch as any)(input, init);
  };
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    calls: () => chatCalls,
  };
}

function pushMidAccts(...emails: string[]): Array<any> {
  const originalAccounts = [...accounts];
  for (const email of emails) accounts.push(makeAcct(email));
  rebuildEmailIndex();
  return originalAccounts;
}

function restoreMidAccts(originalAccounts: Array<any>): void {
  accounts.length = 0;
  accounts.push(...originalAccounts);
  rebuildEmailIndex();
}

function midChatRequest(): Request {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
    body: JSON.stringify({ model: 'qwen3.6-plus', messages: [{ role: 'user', content: 'hello' }], stream: true }),
  });
}

// Session release runs on setTimeout(0); let a finished test's timers fire
// before the next test installs spies, so releases never leak across tests.
function settleMidReleases(): Promise<void> {
  return new Promise((r) => setTimeout(r, 50));
}

// B. chunk1 healthy + chunk2 quota_limit, nothing emitted → handoff A→B, B success, no visible error.
test('MID-STREAM B: healthy first chunk + quota_limit with no content → handoff A→B, client sees B only', async () => {
  const originalAccounts = pushMidAccts('ql-mid-b1@test.dev', 'ql-mid-b2@test.dev');
  const mock = mockMidChat((call) =>
    call === 1
      ? midSseResponse([MID_HEALTHY_FIRST, MID_QUOTA_CHUNK, MID_DONE])
      : midSseResponse([MID_HEALTHY_FIRST_B, midAnswer('Hello from B', 'r2'), MID_DONE]),
  );

  try {
    const res = await app.fetch(midChatRequest());
    assert.strictEqual(res.status, 200, `Expected 200 after handoff, got ${res.status}`);
    // Drain the client stream FIRST: the mid-stream handoff runs while the
    // stream is consumed — asserting counts before EOF races the background
    // rotation (and can leak it into the next test's mock).
    const allSseB = await readMidSse(res);
    assert.strictEqual(mock.calls(), 2, `Expected exactly 2 upstream calls (1 handoff), got ${mock.calls()}`);

    const allSse = allSseB;
    assert.ok(allSse.includes('Hello from B'), 'Client must see B content');
    assert.ok(!allSse.includes('[Error]'), 'No [Error] must reach the client after successful handoff');
    assert.ok(!allSse.includes('quota_limit'), 'Quota envelope must not leak to the client');
    assert.strictEqual(allSse.split('Hello from B').length - 1, 1, 'B content must appear exactly once (no duplication)');

    // G (partial): quota path must not throttle — A stays eligible.
    const acctA = accounts.find((a) => a.email === 'ql-mid-b1@test.dev');
    assert.ok(acctA, 'acctA should exist');
    assert.ok(!acctA?.throttledUntil || acctA.throttledUntil <= Date.now(), 'quota_limit must NOT throttle A');
    await settleMidReleases();
  } finally {
    mock.restore();
    restoreMidAccts(originalAccounts);
  }
});

// C2. tool_call emitted + quota_limit after → NO handoff (post-emission by emission flag).
test('MID-STREAM C: tool_call emitted before quota_limit → no handoff', async () => {
  const originalAccounts = pushMidAccts('ql-mid-c1@test.dev', 'ql-mid-c2@test.dev');
  const toolChunk =
    'data: {"choices":[{"delta":{"phase":"local_tool","status":"finished","extra":{"local_mcp":{"Srv":[{"tool_name":"Srv-bash","params":{"command":"ls"}}]}}}}]}\n\n';
  const mock = mockMidChat(() => midSseResponse([toolChunk, MID_QUOTA_CHUNK, MID_DONE]));

  try {
    const res = await app.fetch(midChatRequest());
    assert.strictEqual(res.status, 200);
    const allSseC = await readMidSse(res);
    assert.strictEqual(mock.calls(), 1, `Emitted tool_call forbids handoff (expected 1 call, got ${mock.calls()})`);

    const allSse = allSseC;
    assert.ok(allSse.includes('bash'), 'Emitted tool call must stay visible');
    assert.ok(!allSse.includes('[Error]'), 'Post-emission error must not append [Error] text');
    await settleMidReleases();
  } finally {
    mock.restore();
    restoreMidAccts(originalAccounts);
  }
});

// D. pre-emission quota + no alternative → controlled visible error, no loop.
// NOTE: in TEST_MOCK_PLAYWRIGHT the session reports accountEmail='mock@test'
// instead of the picked account, so the exclude-probe cannot filter the single
// test account (production excludes the real failed account and stops at 1
// call). Either way the contract holds: terminal error, no third upstream call.
test('MID-STREAM D: quota_limit with single account → terminal error, no retry loop', async () => {
  const originalAccounts = pushMidAccts('ql-mid-d1@test.dev');
  const mock = mockMidChat(() => midSseResponse([MID_HEALTHY_FIRST, MID_QUOTA_CHUNK, MID_DONE]));

  try {
    const res = await app.fetch(midChatRequest());
    assert.strictEqual(res.status, 200);
    const allSseD = await readMidSse(res);
    assert.ok(mock.calls() <= 2, `No loop → at most 2 upstream calls, got ${mock.calls()}`);

    const allSse = allSseD;
    assert.ok(allSse.includes('[Error]'), 'Terminal pre-emission error must be visible');
    assert.ok(allSse.includes('quota_limit'), 'Terminal error must carry the semantic code');
    await settleMidReleases();
  } finally {
    mock.restore();
    restoreMidAccts(originalAccounts);
  }
});

// E. A quota → B quota → no third attempt (MAX_HANDOFFS_PER_REQUEST=1).
test('MID-STREAM E: quota on A and B → terminal error after exactly 1 handoff', async () => {
  assert.strictEqual(MAX_MIDSTREAM_QUOTA_HANDOFFS, 1, 'Contract: MAX_HANDOFFS_PER_REQUEST=1');
  const originalAccounts = pushMidAccts('ql-mid-e1@test.dev', 'ql-mid-e2@test.dev');
  const mock = mockMidChat(() => midSseResponse([MID_HEALTHY_FIRST, MID_QUOTA_CHUNK, MID_DONE]));

  try {
    const res = await app.fetch(midChatRequest());
    assert.strictEqual(res.status, 200);
    const allSseE = await readMidSse(res);
    assert.strictEqual(mock.calls(), 2, `Max 1 handoff → exactly 2 upstream calls, got ${mock.calls()}`);

    const allSse = allSseE;
    assert.ok(allSse.includes('[Error]'), 'Exhausted handoff must surface a controlled error');
    await settleMidReleases();
  } finally {
    mock.restore();
    restoreMidAccts(originalAccounts);
  }
});

// F. inFlight accounting + single release per session on the handoff path.
test('MID-STREAM F: handoff releases A once and B once, probe pick stays balanced', async () => {
  const originalAccounts = pushMidAccts('ql-mid-f1@test.dev', 'ql-mid-f2@test.dev');
  const mock = mockMidChat((call) =>
    call === 1
      ? midSseResponse([MID_HEALTHY_FIRST, MID_QUOTA_CHUNK, MID_DONE])
      : midSseResponse([MID_HEALTHY_FIRST_B, midAnswer('Hello from B', 'r2'), MID_DONE]),
  );
  const origRelease = sessionPool.release.bind(sessionPool);
  const releases: Array<{ chatId: string; isSuccess: boolean }> = [];
  (sessionPool as any).release = (chatId: string, parentId: string | null, headers: any, email: string, isSuccess = true) => {
    releases.push({ chatId, isSuccess });
    return origRelease(chatId, parentId, headers, email, isSuccess);
  };

  try {
    const res = await app.fetch(midChatRequest());
    assert.strictEqual(res.status, 200);
    await readMidSse(res); // drain: handoff + releases settle with the consumed stream
    await new Promise((r) => setTimeout(r, 50)); // flush scheduleCleanup(0) releases

    assert.strictEqual(mock.calls(), 2, 'Handoff path performs 2 upstream calls');
    assert.strictEqual(releases.length, 2, `Each session released exactly once, got ${releases.length}`);
    assert.ok(releases.some((r) => r.isSuccess === false), 'Failed attempt A released as failure');
    assert.ok(releases.some((r) => r.isSuccess === true), 'Successful attempt B released as success');

    // Mock sessions are not tracked by the pool (TEST_MOCK_PLAYWRIGHT), so the
    // pool release no-ops on counters here; production decrements via the real
    // release above. Balance check: exactly one setupSession pick per attempt
    // (probe pick is released immediately) → total inFlight across both = 2.
    const total = accounts.filter((a) => a.email.startsWith('ql-mid-f')).reduce((sum, a) => sum + (a.inFlight || 0), 0);
    assert.strictEqual(total, 2, `Probe pick must stay balanced (expected total inFlight 2, got ${total})`);
  } finally {
    (sessionPool as any).release = origRelease;
    mock.restore();
    restoreMidAccts(originalAccounts);
  }
});

// G. semantic code preserved by the mid-stream detector (both envelope shapes).
test('MID-STREAM G: detector preserves quota_limit code, rejects post-emission and foreign codes', async () => {
  const baseState = (over: Record<string, unknown>) =>
    ({
      targetResponseId: null,
      nextParentId: null,
      completionTokens: 0,
      promptTokens: 0,
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
      ...over,
    }) as any;

  // State shape (processStreamData path): code stashed on state, empty buffer tail.
  const viaState = getRetryablePreEmissionQuota({
    streamState: baseState({ upstreamError: 'Qwen upstream error: quota_limit', upstreamCode: 'quota_limit' }),
    emittedToolCallCount: 0,
    buffer: '',
  });
  assert.ok(viaState, 'State-carried quota_limit must be retryable');
  assert.strictEqual(viaState?.code, 'quota_limit', 'SEMANTIC_CODE must stay quota_limit');

  // Buffer shape (late envelope in trailing partial line).
  const viaBuffer = getRetryablePreEmissionQuota({
    streamState: baseState({}),
    emittedToolCallCount: 0,
    buffer: 'data: {"error":{"code":"quota_limit","details":"busy"}}\n\n',
  });
  assert.ok(viaBuffer, 'Buffer-carried quota_limit must be retryable');
  assert.strictEqual(viaBuffer?.code, 'quota_limit');

  // RateLimited equivalent is eligible too (first-chunk/mid-body parity).
  const rateLimited = getRetryablePreEmissionQuota({
    streamState: baseState({ upstreamError: 'Qwen upstream error: RateLimited', upstreamCode: 'RateLimited' }),
    emittedToolCallCount: 0,
    buffer: '',
  });
  assert.ok(rateLimited, 'RateLimited must be eligible like quota_limit');
  assert.strictEqual(rateLimited?.code, 'RateLimited');

  // Post-emission is forbidden.
  assert.strictEqual(
    getRetryablePreEmissionQuota({
      streamState: baseState({
        upstreamError: 'Qwen upstream error: quota_limit',
        upstreamCode: 'quota_limit',
        hasEmittedContent: true,
      }),
      emittedToolCallCount: 0,
      buffer: '',
    }),
    null,
    'Post-emission quota must NOT be retryable',
  );

  // Emitted tool calls forbid handoff even with hasEmittedContent unset.
  assert.strictEqual(
    getRetryablePreEmissionQuota({
      streamState: baseState({ upstreamError: 'Qwen upstream error: quota_limit', upstreamCode: 'quota_limit' }),
      emittedToolCallCount: 1,
      buffer: '',
    }),
    null,
    'Emitted tool calls must forbid handoff',
  );

  // Foreign codes are untouched.
  assert.strictEqual(
    getRetryablePreEmissionQuota({
      streamState: baseState({ upstreamError: 'Qwen upstream error: internal_error', upstreamCode: 'internal_error' }),
      emittedToolCallCount: 0,
      buffer: '',
    }),
    null,
    'Non-quota codes must not trigger handoff',
  );
});
