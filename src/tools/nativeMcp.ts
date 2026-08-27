/**
 * Native MCP protocol translation layer.
 *
 * Translates between OpenAI tool format and Qwen's native
 * feature_config.local_mcp / phase:"local_tool" protocol.
 */

import type { FunctionToolDefinition, JsonSchema, MessageToolCall, ParsedToolCall } from '../types/openai.ts';

export type { FunctionToolDefinition };

// ── Constants ──────────────────────────────────────────────────────

/** Stable namespace for externally-provided OpenAI tools. */
export const OPENAI_MCP_NAMESPACE = 'OpenAI';

export interface NativeToolCallState {
  mcpName: string;
  toolName: string;
  chatId: string;
  parentId: string;
  accountEmail: string;
  sessionHeaders: { cookie: string; userAgent: string };
  functionFid: string;
}

const nativeToolCallStates = new Map<string, NativeToolCallState>();

export function rememberNativeToolCalls(toolCalls: ParsedToolCall[], state: Omit<NativeToolCallState, 'mcpName' | 'toolName'>): void {
  for (const toolCall of toolCalls) {
    nativeToolCallStates.set(toolCall.id, {
      ...state,
      mcpName: toolCall.mcpName || OPENAI_MCP_NAMESPACE,
      toolName: toolCall.name,
    });
  }
}

export function getNativeToolCallState(toolCallId: string): NativeToolCallState | undefined {
  return nativeToolCallStates.get(toolCallId);
}

export function forgetNativeToolCalls(toolCallIds: string[]): void {
  for (const toolCallId of toolCallIds) nativeToolCallStates.delete(toolCallId);
}

// ── OpenAI tools[] → local_mcp ────────────────────────────────────

/**
 * Convert OpenAI function tool definitions to Qwen's native local_mcp format.
 *
 * ```json
 * feature_config.local_mcp = {
 *   "OpenAI": {
 *     "read_file": {
 *       "description": "Read a file",
 *       "input_schema": { "type": "object", "properties": { "path": { "type": "string" } } }
 *     }
 *   }
 * }
 * ```
 *
 * Preserves: description, parameters/input_schema (full JSON Schema),
 * required, enums, arrays, nested objects, additionalProperties, $defs, etc.
 */
export function toolsToLocalMcp(
  tools: FunctionToolDefinition[],
  namespace: string = OPENAI_MCP_NAMESPACE,
): Record<string, Record<string, { description: string; input_schema: JsonSchema }>> {
  const serverTools: Record<string, { description: string; input_schema: JsonSchema }> = {};

  for (const tool of tools) {
    const fn = tool.function;
    if (!fn?.name) continue;

    serverTools[fn.name] = {
      description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} },
    };
  }

  return { [namespace]: serverTools };
}

// ── SSE local_tool → OpenAI tool_calls ────────────────────────────

/**
 * Accumulated state for parsing a local_tool SSE phase.
 * The model may emit multiple `typing` chunks before `finished`.
 */
export interface LocalToolAccumulator {
  /** Server name (e.g. "OpenAI", "Filesystem") */
  mcpName: string | null;
  /** Tool name within the server */
  toolName: string | null;
  /** Parsed parameters from extra.local_mcp */
  params: Record<string, unknown> | null;
  /** Whether we've seen the finished status */
  finished: boolean;
  /** response_id from the SSE event (needed for parentId in continuation) */
  responseId: string | null;
}

/**
 * Create a fresh accumulator for a new local_tool phase.
 */
export function createLocalToolAccumulator(): LocalToolAccumulator {
  return { mcpName: null, toolName: null, params: null, finished: false, responseId: null };
}

/**
 * Feed a single SSE chunk into the accumulator.
 * Returns true when the tool call is complete (status=finished).
 */
export function feedLocalToolChunk(acc: LocalToolAccumulator, sseData: any): boolean {
  const delta = sseData?.choices?.[0]?.delta;
  if (!delta || delta.phase !== 'local_tool') return false;

  // Track response_id for parentId
  if (sseData['response.created']?.response_id) {
    acc.responseId = sseData['response.created'].response_id;
  } else if (sseData.response_id && !acc.responseId) {
    acc.responseId = sseData.response_id;
  }

  // Extract server name and tool name from the typing chunk
  if (delta.mcp_name) acc.mcpName = delta.mcp_name;
  if (delta.tool_name) acc.toolName = delta.tool_name;

  // Extract params from extra.local_mcp on finished chunk
  const localMcp = delta.extra?.local_mcp;
  if (localMcp && typeof localMcp === 'object') {
    // Find the first server in local_mcp
    for (const [serverName, tools] of Object.entries(localMcp)) {
      if (!Array.isArray(tools)) continue;
      for (const tool of tools as any[]) {
        if (tool?.tool_name && tool?.params !== undefined) {
          acc.mcpName = acc.mcpName || serverName;
          acc.toolName = acc.toolName || tool.tool_name;
          acc.params = tool.params;
          break;
        }
      }
      if (acc.params) break;
    }
  }

  // Check for finished status
  if (delta.status === 'finished') {
    acc.finished = true;
    return true;
  }

  return false;
}

/**
 * Convert an accumulated local_tool result to an OpenAI tool_calls MessageToolCall.
 */
export function localToolToOpenAIToolCall(acc: LocalToolAccumulator, index: number): MessageToolCall | null {
  if (!acc.toolName || !acc.params) return null;

  return {
    id: `call_${crypto.randomUUID()}`,
    type: 'function',
    function: {
      name: acc.toolName,
      arguments: JSON.stringify(acc.params),
    },
  };
}

// ── Tool result OpenAI → Qwen role=function ───────────────────────

/**
 * Build a Qwen-native role:function message from an OpenAI role:tool message.
 *
 * The Qwen continuation format requires:
 * ```json
 * {
 *   "role": "function",
 *   "content": {
 *     "<mcp_name>": [{ "<tool_name>": "<serialized result>" }]
 *   }
 * }
 * ```
 */
export function buildFunctionResultMessage(
  toolCallId: string,
  toolResultContent: string,
  toolCallMap: Map<string, { mcpName: string; toolName: string }>,
): { role: string; content: Record<string, unknown>; [key: string]: unknown } | null {
  const mapping = toolCallMap.get(toolCallId);
  if (!mapping) return null;

  return {
    role: 'function',
    content: {
      [mapping.mcpName]: [{ [mapping.toolName]: toolResultContent }],
    },
  };
}

// ── Mapping helpers ────────────────────────────────────────────────

/**
 * Build a stable tool_call_id → {mcpName, toolName} mapping.
 * Used to translate role=tool results back to role=function.
 */
export function buildToolCallMap(toolCalls: MessageToolCall[], mcpName: string): Map<string, { mcpName: string; toolName: string }> {
  const map = new Map<string, { mcpName: string; toolName: string }>();
  for (const tc of toolCalls) {
    map.set(tc.id, { mcpName, toolName: tc.function.name });
  }
  return map;
}
