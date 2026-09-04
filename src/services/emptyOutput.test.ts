import { describe, expect, test } from 'bun:test';
import { EMPTY_UPSTREAM_CODE, isBlankText, isEmptyOutput, isShortContent, isYesOnly, SHORT_CONTENT_MAX } from './emptyOutput.ts';

describe('empty-output contract', () => {
  test('EMPTY_UPSTREAM_CODE is stable', () => {
    expect(EMPTY_UPSTREAM_CODE).toBe('empty_upstream_response');
  });

  test('isEmptyOutput requires content+reasoning+tools all absent', () => {
    expect(isEmptyOutput({ content: '', reasoning: '', toolCallCount: 0 })).toBe(true);
    expect(isEmptyOutput({ content: '  \n ', reasoning: null, toolCallCount: 0 })).toBe(true);
    expect(isEmptyOutput({ content: 'hi', reasoning: '', toolCallCount: 0 })).toBe(false);
    expect(isEmptyOutput({ content: '', reasoning: 'thinking', toolCallCount: 0 })).toBe(false);
    expect(isEmptyOutput({ content: '', reasoning: '', toolCallCount: 1 })).toBe(false);
  });

  test('isYesOnly matches case-insensitively with whitespace', () => {
    expect(isYesOnly('yes')).toBe(true);
    expect(isYesOnly('Yes')).toBe(true);
    expect(isYesOnly('YES')).toBe(true);
    expect(isYesOnly('  yes\n')).toBe(true);
    expect(isYesOnly('yes, hostname is quant')).toBe(false);
    expect(isYesOnly('')).toBe(false);
    expect(isYesOnly(null)).toBe(false);
  });

  test('isShortContent bounds extremely short text', () => {
    expect(isShortContent('yes')).toBe(true);
    expect(isShortContent('x'.repeat(SHORT_CONTENT_MAX))).toBe(true);
    expect(isShortContent('x'.repeat(SHORT_CONTENT_MAX + 1))).toBe(false);
    expect(isShortContent('')).toBe(false);
    expect(isShortContent(null)).toBe(false);
  });

  test('isBlankText', () => {
    expect(isBlankText('')).toBe(true);
    expect(isBlankText('   ')).toBe(true);
    expect(isBlankText(null)).toBe(true);
    expect(isBlankText('x')).toBe(false);
  });
});
