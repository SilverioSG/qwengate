/**
 * Append-only anomaly observability for the next real "yes-only" /
 * empty-upstream incident.
 *
 * - In-memory aggregation is NOT enough: anomalies must survive restarts,
 *   so records persist to `.qwen/anomalies.jsonl` (runtime data dir,
 *   same convention as usage.json / monitor.json).
 * - Persists ONLY on anomaly detection (yes_only / empty_upstream /
 *   short_then_error). Normal traffic writes nothing here.
 * - Never stores: cookies, tokens, Authorization, credentials, full
 *   prompts, attachments, prod-auth data, or full responses — only
 *   small sanitized previews/tails (<= ANOMALY_PREVIEW_MAX chars).
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { projectPath } from '../utils/paths.ts';
import { logStore } from './logStore.ts';

export type AnomalyType = 'yes_only' | 'empty_upstream' | 'short_then_error';

export interface AnomalyRecord {
  type: AnomalyType;
  requestId: string;
  timestamp: string;
  model: string;
  account: string;
  stream: boolean;
  messageCount: number | null;
  msgSizes: string | null;
  toolsPresent: boolean | null;
  contextFileUsed: boolean | null;
  contextUploadFailed: boolean | null;
  rawAnswerChunkCount: number | null;
  nonEmptyAnswerChunkCount: number | null;
  reasoningChunkCount: number | null;
  toolCallCount: number;
  firstAnswerPreview: string | null;
  lastAnswerPreview: string | null;
  gateFinalPreview: string | null;
  finalContentLength: number;
  reasoningLength: number;
  hasEmittedContent: boolean | null;
  upstreamErrorClass: string | null;
  upstreamErrorAfterContent: boolean;
  finishStatus: string | null;
  streamEOF: boolean | null;
  streamTimeout: boolean | null;
  clientDisconnected: boolean | null;
}

export const ANOMALY_PREVIEW_MAX = 256;
export const MAX_ANOMALY_RECORDS = 200;

export function defaultAnomalyFile(): string {
  // Test/operator override; default keeps the runtime-data convention (.qwen/).
  const override = process.env.QWEN_ANOMALY_FILE;
  if (override && override.trim()) return override;
  return projectPath('.qwen', 'anomalies.jsonl');
}

const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // Bearer first: the generic authorization pattern would otherwise eat the
  // "Bearer" keyword and leave the token value behind.
  { re: /bearer\s+[A-Za-z0-9\-._~+/=]+/gi, replacement: 'bearer [redacted]' },
  { re: /authorization["']?\s*[:=]\s*["']?[^"'\s,;}]+/gi, replacement: 'authorization=[redacted]' },
  { re: /cookie["']?\s*[:=]\s*["']?[^"'\s,;}]+/gi, replacement: 'cookie=[redacted]' },
  { re: /(token|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?[^"'\s,;}]+/gi, replacement: '$1=[redacted]' },
  { re: /x-hif-[a-z]+\s*[:=]\s*[^\s,;}]+/gi, replacement: '[redacted]' },
];

/** Sanitize a preview: redact secrets, strip control chars, cap length. */
export function sanitizePreview(value: unknown, max: number = ANOMALY_PREVIEW_MAX): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  let out = value;
  for (const { re, replacement } of SECRET_PATTERNS) out = out.replace(re, replacement);
  // Strip C0 control chars while preserving whitespace separators.
  out = out.replace(/\p{Cc}/gu, (char) => (char === '\t' || char === '\n' || char === '\r' ? char : ' '));
  if (out.length > max) out = out.slice(-max);
  return out;
}

/**
 * Append one anomaly record (JSONL). Rotates by record count so the file
 * stays bounded. Never throws — observability must not break requests.
 */
export function recordAnomaly(record: AnomalyRecord, filePath?: string): void {
  try {
    const file = filePath ?? defaultAnomalyFile();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf-8', mode: 0o600 });
    chmodSync(file, 0o600);
    rotateAnomalyFile(file);
  } catch {
    /* observability must never break the request path */
  }
}

function readRecordCount(file: string): number {
  try {
    if (!existsSync(file)) return 0;
    if (statSync(file).size === 0) return 0;
    const raw = readFileSync(file, 'utf-8');
    let count = 0;
    for (const line of raw.split('\n')) if (line.trim()) count++;
    return count;
  } catch {
    return 0;
  }
}

/** Keep only the newest MAX_ANOMALY_RECORDS records. */
export function rotateAnomalyFile(file: string, maxRecords: number = MAX_ANOMALY_RECORDS): void {
  try {
    const count = readRecordCount(file);
    if (count <= maxRecords) return;
    const raw = readFileSync(file, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const kept = lines.slice(-maxRecords);
    writeFileSync(file, kept.join('\n') + '\n', 'utf-8');
  } catch {
    /* best effort */
  }
}

export interface AnomalyContextInput {
  logId: string;
  requestId: string;
  model: string;
  account: string;
  stream: boolean;
  /** Accumulated raw answer text (head ≈ first preview, tail ≈ last preview). */
  rawAnswerText?: string;
  /** Final assistant text as the gate will report it. */
  gateFinalText?: string;
  finalContentLength: number;
  reasoningLength: number;
  toolCallCount: number;
  rawAnswerChunkCount?: number | null;
  nonEmptyAnswerChunkCount?: number | null;
  reasoningChunkCount?: number | null;
  hasEmittedContent?: boolean | null;
  upstreamErrorClass?: string | null;
  upstreamErrorAfterContent?: boolean;
  finishStatus?: string | null;
  streamEOF?: boolean | null;
  streamTimeout?: boolean | null;
  clientDisconnected?: boolean | null;
}

/**
 * Build a record from operational log metadata (messageCount, msgSizes,
 * toolsPresent live on the logStore entry) plus explicit runtime state.
 * Falls back to nulls when the entry is missing — never throws.
 */
export function buildAnomalyRecord(type: AnomalyType, input: AnomalyContextInput): AnomalyRecord {
  let messageCount: number | null = null;
  let msgSizes: string | null = null;
  let toolsPresent: boolean | null = null;
  let contextFileUsed: boolean | null = null;
  let contextUploadFailed: boolean | null = null;
  try {
    const entry = logStore.getEntry(input.logId) as any;
    const cr = entry?.clientRequest;
    if (cr) {
      messageCount = typeof cr.messageCount === 'number' ? cr.messageCount : null;
      if (Array.isArray(cr.messages)) {
        msgSizes = cr.messages.map((m: any) => `${m.role}:${typeof m.content === 'string' ? m.content.length : 0}`).join(',');
      }
      toolsPresent = typeof cr.hasTools === 'boolean' ? cr.hasTools : null;
    }
    if (entry?.contextFlags && typeof entry.contextFlags === 'object') {
      contextFileUsed = entry.contextFlags.contextFileUsed ?? null;
      contextUploadFailed = entry.contextFlags.contextUploadFailed ?? null;
    }
  } catch {
    /* fallbacks stand */
  }
  const raw = typeof input.rawAnswerText === 'string' ? input.rawAnswerText : '';
  const gateFinal = typeof input.gateFinalText === 'string' ? input.gateFinalText : raw;
  return {
    type,
    requestId: input.requestId,
    timestamp: new Date().toISOString(),
    model: input.model,
    account: input.account,
    stream: input.stream,
    messageCount,
    msgSizes,
    toolsPresent,
    contextFileUsed,
    contextUploadFailed,
    rawAnswerChunkCount: input.rawAnswerChunkCount ?? null,
    nonEmptyAnswerChunkCount: input.nonEmptyAnswerChunkCount ?? null,
    reasoningChunkCount: input.reasoningChunkCount ?? null,
    toolCallCount: input.toolCallCount,
    firstAnswerPreview: raw ? sanitizePreview(raw.slice(0, ANOMALY_PREVIEW_MAX)) : null,
    lastAnswerPreview: raw ? sanitizePreview(raw) : null,
    gateFinalPreview: gateFinal ? sanitizePreview(gateFinal) : null,
    finalContentLength: input.finalContentLength,
    reasoningLength: input.reasoningLength,
    hasEmittedContent: input.hasEmittedContent ?? null,
    upstreamErrorClass: input.upstreamErrorClass ?? null,
    upstreamErrorAfterContent: input.upstreamErrorAfterContent ?? false,
    finishStatus: input.finishStatus ?? null,
    streamEOF: input.streamEOF ?? null,
    streamTimeout: input.streamTimeout ?? null,
    clientDisconnected: input.clientDisconnected ?? null,
  };
}
