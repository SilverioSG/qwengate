import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANOMALY_PREVIEW_MAX,
  buildAnomalyRecord,
  MAX_ANOMALY_RECORDS,
  recordAnomaly,
  rotateAnomalyFile,
  sanitizePreview,
} from './anomalyLog.ts';

let tmpFiles: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qg-anomaly-'));
  const file = join(dir, 'anomalies.jsonl');
  tmpFiles.push(dir);
  return file;
}
afterEach(() => {
  for (const d of tmpFiles) rmSync(d, { recursive: true, force: true });
  tmpFiles = [];
});

function baseRecord(overrides: Record<string, unknown> = {}) {
  return buildAnomalyRecord('yes_only', {
    logId: 'missing-log-id',
    requestId: 'req-1',
    model: 'qwen3-max',
    account: 'op@test',
    stream: true,
    rawAnswerText: 'yes',
    gateFinalText: 'yes',
    finalContentLength: 3,
    reasoningLength: 0,
    toolCallCount: 0,
    ...overrides,
  });
}

describe('anomalyLog', () => {
  test('YES_ONLY record persists exactly one JSONL line', () => {
    const file = tmpFile();
    recordAnomaly(baseRecord(), file);
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.type).toBe('yes_only');
    expect(rec.requestId).toBe('req-1');
    expect(rec.gateFinalPreview).toBe('yes');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('SECRET_SANITIZATION: no credentials leak into previews', () => {
    const evil = 'yes Authorization: Bearer abc123 cookie: sess=xyz token=tok123';
    const rec = baseRecord({ rawAnswerText: evil, gateFinalText: evil });
    expect(JSON.stringify(rec)).not.toContain('abc123');
    expect(JSON.stringify(rec)).not.toContain('sess=xyz');
    expect(JSON.stringify(rec)).not.toContain('tok123');
    expect(sanitizePreview('Authorization: Bearer abc123')).not.toContain('abc123');
    expect(sanitizePreview('Authorization: Bearer abc123')).toContain('[redacted]');
    expect(sanitizePreview('{"token":"json-secret","api_key":"json-key"}')).not.toContain('json-secret');
    expect(sanitizePreview('{"token":"json-secret","api_key":"json-key"}')).not.toContain('json-key');
  });

  test('TRUNCATION: previews capped at ANOMALY_PREVIEW_MAX', () => {
    const big = 'x'.repeat(ANOMALY_PREVIEW_MAX + 500);
    const rec = baseRecord({ rawAnswerText: big, gateFinalText: big });
    expect(rec.firstAnswerPreview!.length).toBeLessThanOrEqual(ANOMALY_PREVIEW_MAX);
    expect(rec.lastAnswerPreview!.length).toBeLessThanOrEqual(ANOMALY_PREVIEW_MAX);
    expect(rec.gateFinalPreview!.length).toBeLessThanOrEqual(ANOMALY_PREVIEW_MAX);
  });

  test('ROTATION: file never exceeds MAX_ANOMALY_RECORDS', () => {
    const file = tmpFile();
    for (let i = 0; i < MAX_ANOMALY_RECORDS + 50; i++) {
      recordAnomaly(baseRecord({ requestId: `req-${i}` }), file);
    }
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(MAX_ANOMALY_RECORDS);
    // Newest records survive rotation
    expect(JSON.parse(lines[lines.length - 1]).requestId).toBe(`req-${MAX_ANOMALY_RECORDS + 49}`);
  });

  test('rotateAnomalyFile keeps newest records', () => {
    const file = tmpFile();
    for (let i = 0; i < 10; i++) recordAnomaly(baseRecord({ requestId: `r${i}` }), file);
    rotateAnomalyFile(file, 4);
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBe(4);
    expect(JSON.parse(lines[0]).requestId).toBe('r6');
  });

  test('recordAnomaly never throws on bad path', () => {
    expect(() => recordAnomaly(baseRecord(), '/proc/definitely-not-writable/an.jsonl')).not.toThrow();
  });

  test('missing log entry degrades to nulls, still records', () => {
    const file = tmpFile();
    const rec = baseRecord();
    expect(rec.messageCount).toBeNull();
    expect(rec.msgSizes).toBeNull();
    recordAnomaly(rec, file);
    expect(readFileSync(file, 'utf-8').split('\n').filter(Boolean).length).toBe(1);
  });
});
