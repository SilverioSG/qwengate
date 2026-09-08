import { describe, expect, test } from 'bun:test';
import { buildQwenBrowserHeaders, QWEN_BROWSER_USER_AGENT, QWEN_CLIENT_HINTS } from './qwenHeaders.ts';

describe('Qwen browser request profile', () => {
  test('keeps UA and client hints coherent for file endpoints', () => {
    const headers = buildQwenBrowserHeaders('token=T', { method: 'POST', userAgent: QWEN_BROWSER_USER_AGENT });

    expect(headers['user-agent']).toBe(QWEN_BROWSER_USER_AGENT);
    expect(headers['sec-ch-ua']).toBe(QWEN_CLIENT_HINTS['sec-ch-ua']);
    expect(headers['sec-ch-ua-mobile']).toBe('?0');
    expect(headers['sec-ch-ua-platform']).toBe('"Linux"');
    expect(headers.referer).toBe('https://chat.qwen.ai/');
    expect(headers.cookie).toBe('token=T');
  });

  test('supports the JSON POST shape used by getstsToken and parse endpoints', () => {
    const headers = buildQwenBrowserHeaders('token=T', {
      method: 'POST',
      userAgent: QWEN_BROWSER_USER_AGENT,
      contentType: 'application/json',
    });

    expect(headers['content-type']).toBe('application/json');
    expect(headers.source).toBe('web');
    expect(headers.origin).toBe('https://chat.qwen.ai');
  });
});
