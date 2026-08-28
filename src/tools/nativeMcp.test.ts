import assert from 'node:assert';
import test from 'node:test';
import type { FunctionToolDefinition } from '../types/openai.ts';
import {
  createLocalToolAccumulator,
  feedLocalToolChunk,
  localToolToOpenAIToolCall,
  OPENAI_MCP_NAMESPACE,
  toolsToLocalMcp,
} from './nativeMcp.ts';

// ── toolsToLocalMcp ──────────────────────────────────────────────

test('toolsToLocalMcp: empty array returns empty namespace', () => {
  const result = toolsToLocalMcp([]);
  assert.deepStrictEqual(result, { [OPENAI_MCP_NAMESPACE]: {} });
});

test('toolsToLocalMcp: single tool with full schema', () => {
  const tools: FunctionToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from disk',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
          },
          required: ['path'],
        },
      },
    },
  ];

  const result = toolsToLocalMcp(tools);
  const server = result[OPENAI_MCP_NAMESPACE];
  assert.ok(server, 'should have OpenAI namespace');
  assert.deepStrictEqual(Object.keys(server), ['read_file']);
  assert.strictEqual(server['read_file'].description, 'Read a file from disk');
  assert.deepStrictEqual(server['read_file'].input_schema, {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path' } },
    required: ['path'],
  });
});

test('toolsToLocalMcp: multiple tools', () => {
  const tools: FunctionToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run bash command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search files',
        parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } } },
      },
    },
  ];

  const result = toolsToLocalMcp(tools);
  const server = result[OPENAI_MCP_NAMESPACE];
  assert.strictEqual(Object.keys(server).length, 2);
  assert.ok(server['bash']);
  assert.ok(server['grep']);
});

test('toolsToLocalMcp: custom namespace', () => {
  const tools: FunctionToolDefinition[] = [
    { type: 'function', function: { name: 'tool_a', description: 'A', parameters: { type: 'object', properties: {} } } },
  ];

  const result = toolsToLocalMcp(tools, 'MyServer');
  assert.ok(result['MyServer']);
  assert.ok(!result[OPENAI_MCP_NAMESPACE]);
});

test('toolsToLocalMcp: preserves complex JSON Schema', () => {
  const schema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: { type: 'string', enum: ['a', 'b', 'c'] },
      },
      nested: {
        type: 'object',
        properties: {
          deep: { type: 'boolean' },
        },
      },
    },
    additionalProperties: false,
  };

  const tools: FunctionToolDefinition[] = [{ type: 'function', function: { name: 'complex', description: '', parameters: schema } }];

  const result = toolsToLocalMcp(tools);
  assert.deepStrictEqual(result[OPENAI_MCP_NAMESPACE]['complex'].input_schema, schema);
});

test('toolsToLocalMcp: missing description defaults to empty string', () => {
  const tools: FunctionToolDefinition[] = [
    { type: 'function', function: { name: 'no_desc', parameters: { type: 'object', properties: {} } } },
  ];

  const result = toolsToLocalMcp(tools);
  assert.strictEqual(result[OPENAI_MCP_NAMESPACE]['no_desc'].description, '');
});

test('toolsToLocalMcp: missing parameters defaults to empty schema', () => {
  const tools: FunctionToolDefinition[] = [{ type: 'function', function: { name: 'no_params', description: 'Has no params' } }];

  const result = toolsToLocalMcp(tools);
  assert.deepStrictEqual(result[OPENAI_MCP_NAMESPACE]['no_params'].input_schema, { type: 'object', properties: {} });
});

test('toolsToLocalMcp: skips tools without name', () => {
  const tools = [
    { type: 'function', function: { description: 'No name' } },
    { type: 'function', function: { name: 'valid', description: 'Valid' } },
  ] as any[];

  const result = toolsToLocalMcp(tools);
  assert.deepStrictEqual(Object.keys(result[OPENAI_MCP_NAMESPACE]), ['valid']);
});

// ── extractLocalMcpToolCalls (via processStreamData integration) ──

test('extractLocalMcpToolCalls: handles OpenAI namespace', async () => {
  const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

  const sseData = {
    choices: [
      {
        delta: {
          role: 'assistant',
          content: '',
          phase: 'local_tool',
          status: 'finished',
          extra: {
            local_mcp: {
              OpenAI: [{ tool_name: 'read_file', params: { path: '/tmp/test.txt' } }],
            },
          },
        },
      },
    ],
  };

  const result = extractLocalMcpToolCalls(sseData);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].name, 'read_file');
  assert.deepStrictEqual(result[0].arguments, { path: '/tmp/test.txt' });
  assert.ok(result[0].id.startsWith('call_'));
});

test('extractLocalMcpToolCalls: handles ★ namespace', async () => {
  const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

  const sseData = {
    choices: [
      {
        delta: {
          extra: {
            local_mcp: {
              '★': [{ tool_name: '★-bash', params: { command: 'ls' } }],
            },
          },
        },
      },
    ],
  };

  const result = extractLocalMcpToolCalls(sseData);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].name, 'bash');
  assert.deepStrictEqual(result[0].arguments, { command: 'ls' });
});

test('extractLocalMcpToolCalls: handles multiple servers', async () => {
  const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

  const sseData = {
    choices: [
      {
        delta: {
          extra: {
            local_mcp: {
              OpenAI: [{ tool_name: 'bash', params: { command: 'pwd' } }],
              Filesystem: [{ tool_name: 'read_file', params: { path: '/tmp' } }],
            },
          },
        },
      },
    ],
  };

  const result = extractLocalMcpToolCalls(sseData);
  assert.strictEqual(result.length, 2);
  const names = result.map((tc) => tc.name).sort();
  assert.deepStrictEqual(names, ['bash', 'read_file']);
});

test('extractLocalMcpToolCalls: returns empty for no extra', async () => {
  const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');
  const sseData = { choices: [{ delta: { content: 'hello' } }] };
  assert.deepStrictEqual(extractLocalMcpToolCalls(sseData), []);
});

test('extractLocalMcpToolCalls: returns empty for empty local_mcp', async () => {
  const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');
  const sseData = { choices: [{ delta: { extra: { local_mcp: {} } } }] };
  assert.deepStrictEqual(extractLocalMcpToolCalls(sseData), []);
});

test('extractLocalMcpToolCalls: handles non-array server tools', async () => {
  const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');
  const sseData = { choices: [{ delta: { extra: { local_mcp: { OpenAI: 'not-an-array' } } } }] };
  assert.deepStrictEqual(extractLocalMcpToolCalls(sseData), []);
});

// ── Accumulator-based extraction ──────────────────────────────────

test('accumulator: typing -> finished lifecycle', () => {
  const acc = createLocalToolAccumulator();
  assert.strictEqual(acc.finished, false);
  assert.strictEqual(acc.mcpName, null);

  // Typing chunk
  const typingChunk = {
    choices: [{ delta: { role: 'assistant', content: '', phase: 'local_tool', status: 'typing', mcp_name: 'OpenAI', tool_name: 'bash' } }],
  };
  const done1 = feedLocalToolChunk(acc, typingChunk);
  assert.strictEqual(done1, false);
  assert.strictEqual(acc.mcpName, 'OpenAI');
  assert.strictEqual(acc.toolName, 'bash');

  // Finished chunk with params
  const finishedChunk = {
    choices: [
      {
        delta: {
          phase: 'local_tool',
          status: 'finished',
          extra: { local_mcp: { OpenAI: [{ tool_name: 'bash', params: { command: 'ls' } }] } },
        },
      },
    ],
  };
  const done2 = feedLocalToolChunk(acc, finishedChunk);
  assert.strictEqual(done2, true);
  assert.strictEqual(acc.finished, true);
  assert.deepStrictEqual(acc.params, { command: 'ls' });
});

test('accumulator: non-local_tool chunks ignored', () => {
  const acc = createLocalToolAccumulator();
  const answerChunk = { choices: [{ delta: { phase: 'answer', content: 'hello' } }] };
  const done = feedLocalToolChunk(acc, answerChunk);
  assert.strictEqual(done, false);
  assert.strictEqual(acc.finished, false);
});

test('accumulator -> localToolToOpenAIToolCall', () => {
  const acc = createLocalToolAccumulator();
  acc.mcpName = 'OpenAI';
  acc.toolName = 'bash';
  acc.params = { command: 'pwd' };
  acc.finished = true;

  const tc = localToolToOpenAIToolCall(acc, 0);
  assert.ok(tc);
  assert.strictEqual(tc!.function.name, 'bash');
  assert.strictEqual(tc!.function.arguments, '{"command":"pwd"}');
  assert.ok(tc!.id.startsWith('call_'));
});

test('accumulator -> localToolToOpenAIToolCall returns null when incomplete', () => {
  const acc = createLocalToolAccumulator();
  acc.toolName = 'bash';
  // params is null
  const tc = localToolToOpenAIToolCall(acc, 0);
  assert.strictEqual(tc, null);
});

// ── Streaming integration: local_tool content suppression ─────────

test('processStreamData: local_tool phase suppresses content emission', async () => {
  const { processStreamData } = await import('../routes/chatStreamingHelpers.ts');
  const { logStore } = await import('../services/logStore.ts');

  const logId = 'test-local-tool-suppress';
  logStore.createEntry(logId, 'qwen3.7-max', true);

  const state: any = {
    targetResponseId: 'resp_1',
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
    loggedToolCalls: new Set(),
    lastParsePosition: 0,
    toolCallDepth: 0,
    pendingChunk: '',
  };

  const writtenEvents: string[] = [];
  const mockStreamWriter = {
    write: async (chunk: string) => {
      writtenEvents.push(chunk);
    },
  };

  const ctx: any = {
    streamWriter: mockStreamWriter,
    completionId: 'test-comp',
    model: 'qwen3.7-max',
    emittedToolCallCount: 0,
    enableContentFiltering: false,
    cleanOutput: false,
    logId,
    resolvedEmail: 'test@example.com',
    ampState: { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false },
    qwenAbortController: new AbortController(),
  };

  // Emit local_tool finished
  const localToolData = {
    choices: [
      {
        delta: {
          role: 'assistant',
          content: '',
          phase: 'local_tool',
          status: 'finished',
          extra: { local_mcp: { OpenAI: [{ tool_name: 'bash', params: { command: 'ls' } }] } },
        },
      },
    ],
  };

  const result = await processStreamData(localToolData, state, ctx);
  assert.strictEqual(result, 'break_stream');

  // Tool call event should be emitted
  const toolEvents = writtenEvents.filter((e) => e.includes('tool_calls'));
  assert.strictEqual(toolEvents.length, 1, 'should emit one tool call event');
  assert.ok(toolEvents[0].includes('bash'), 'tool call should be bash');

  // No content events should be emitted for local_tool
  const contentEvents = writtenEvents.filter((e) => !e.includes('tool_calls') && e.includes('"content"'));
  assert.strictEqual(contentEvents.length, 0, 'should not emit content during local_tool');
});

// ── buildQwenMessages: upstream replay with Native MCP tools ──────

test('buildQwenMessages: native_mcp mode replays tool results in a root user message', async () => {
  const { buildQwenMessages } = await import('../routes/chatHelpers.ts');

  const messages = [
    { role: 'user', content: 'Read the file /tmp/test.txt' },
    {
      role: 'assistant',
      tool_calls: [{ id: 'call_abc123', type: 'function', function: { name: 'read_file', arguments: '{"path":"/tmp/test.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_abc123', content: 'File contents here' },
  ];

  const body = {
    model: 'qwen3.7-max',
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ],
  };

  const result = buildQwenMessages(messages, body, 100000, true);

  assert.strictEqual(result.qwenMessages.length, 1);
  assert.strictEqual(result.qwenMessages[0].role, 'user');
  assert.strictEqual(result.qwenMessages[0].parent_id, null);
  assert.match(String(result.qwenMessages[0].content), /<user>\nRead the file \/tmp\/test\.txt\n<\/user>/);
  assert.match(String(result.qwenMessages[0].content), /<assist>/);
  assert.match(String(result.qwenMessages[0].content), /<tool-result tool="read_file">\nFile contents here\n<\/tool-result>/);
});

test('buildQwenMessages: native_mcp mode with multiple tool results', async () => {
  const { buildQwenMessages } = await import('../routes/chatHelpers.ts');

  const messages = [
    { role: 'user', content: 'Find files and read one' },
    {
      role: 'assistant',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
        { id: 'call_2', type: 'function', function: { name: 'grep', arguments: '{"pattern":"foo"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'file1.txt\nfile2.txt' },
    { role: 'tool', tool_call_id: 'call_2', content: 'file1.txt:foo bar' },
  ];

  const body = {
    model: 'qwen3.7-max',
    tools: [
      { type: 'function', function: { name: 'bash', description: 'Run bash', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'grep', description: 'Search', parameters: { type: 'object', properties: {} } } },
    ],
  };

  const result = buildQwenMessages(messages, body, 100000, true);

  assert.strictEqual(result.qwenMessages[0].role, 'user');
  assert.strictEqual(result.qwenMessages[0].parent_id, null);
  const content = String(result.qwenMessages[0].content);
  assert.match(content, /<tool-result tool="bash">\nfile1\.txt\nfile2\.txt\n<\/tool-result>/);
  assert.match(content, /<tool-result tool="grep">\nfile1\.txt:foo bar\n<\/tool-result>/);
});

test('buildQwenMessages: non-native_mcp mode wraps tool results as XML', async () => {
  const { buildQwenMessages } = await import('../routes/chatHelpers.ts');

  const messages = [
    { role: 'user', content: 'Read the file' },
    { role: 'tool', name: 'read_file', content: 'File contents' },
  ];

  const body = { model: 'qwen3.7-max' }; // no tools → non-native mode

  const result = buildQwenMessages(messages, body, 100000, false);

  assert.strictEqual(result.qwenMessages.length, 1);
  assert.strictEqual(result.qwenMessages[0].role, 'user');

  // Tool result should be in the user message as XML
  const userContent = result.qwenMessages[0].content as string;
  assert.ok(userContent.includes('<tool-result'), 'should contain XML tool-result tag');
});

test('buildQwenMessages: replay resolves tool_call_id from assistant tool_calls', async () => {
  const { buildQwenMessages } = await import('../routes/chatHelpers.ts');

  const messages = [
    { role: 'user', content: 'List files' },
    {
      role: 'assistant',
      tool_calls: [{ id: 'call_xyz', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_xyz', content: 'file1.txt' },
  ];

  const body = {
    model: 'qwen3.7-max',
    tools: [{ type: 'function', function: { name: 'bash', description: 'Run bash', parameters: { type: 'object', properties: {} } } }],
  };

  const result = buildQwenMessages(messages, body, 100000, true);

  assert.strictEqual(result.qwenMessages[0].role, 'user');
  assert.match(String(result.qwenMessages[0].content), /<tool-result tool="bash">\nfile1\.txt\n<\/tool-result>/);
});

test('buildQwenMessages: native_mcp replays every tool round in a new root message', async () => {
  const { buildQwenMessages } = await import('../routes/chatHelpers.ts');

  const messages = [
    { role: 'user', content: 'Inspect the project in multiple steps' },
    {
      role: 'assistant',
      tool_calls: [{ id: 'call_old_round', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_old_round', content: 'old result' },
    {
      role: 'assistant',
      tool_calls: [{ id: 'call_latest_round', type: 'function', function: { name: 'grep', arguments: '{"pattern":"version"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_latest_round', content: 'latest result' },
  ];

  const result = buildQwenMessages(
    messages,
    {
      model: 'qwen3.7-max',
      tools: [
        { type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'grep', parameters: { type: 'object', properties: {} } } },
      ],
    },
    100000,
    true,
  );

  assert.strictEqual(result.qwenMessages.length, 1);
  assert.strictEqual(result.qwenMessages[0].role, 'user');
  assert.strictEqual(result.qwenMessages[0].parent_id, null);
  const content = String(result.qwenMessages[0].content);
  assert.match(content, /<tool-result tool="bash">\nold result\n<\/tool-result>/);
  assert.match(content, /<tool-result tool="grep">\nlatest result\n<\/tool-result>/);
});

test('buildQwenMessages: historical tool results are not a continuation after a new user message', async () => {
  const { buildQwenMessages } = await import('../routes/chatHelpers.ts');

  const result = buildQwenMessages(
    [
      { role: 'user', content: 'List files' },
      { role: 'assistant', tool_calls: [{ id: 'call_historical', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_historical', content: 'file.txt' },
      { role: 'assistant', content: 'The file is file.txt' },
      { role: 'user', content: 'Now explain the file.' },
    ],
    {
      model: 'qwen3.7-max',
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: {} } } }],
    },
    100000,
    true,
  );

  assert.strictEqual(result.qwenMessages[0].role, 'user');
  assert.strictEqual(result.qwenMessages[0].parent_id, null);
  assert.match(String(result.qwenMessages[0].content), /Now explain the file\./);
});
