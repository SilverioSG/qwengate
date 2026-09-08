import { describe, expect, test } from 'bun:test';
import { buildFileApiRequest } from './qwenFileUpload.ts';

const UA_142_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

describe('file API request profile regression', () => {
  test('keeps the browser profile on getstsToken and parse requests', () => {
    for (const url of [
      'https://chat.qwen.ai/api/v2/files/getstsToken',
      'https://chat.qwen.ai/api/v2/files/parse',
      'https://chat.qwen.ai/api/v2/files/parse/status',
    ]) {
      const req = buildFileApiRequest(url, 'token=T; acw_tc=A', UA_142_LINUX, '{}');
      expect(req.method).toBe('POST');
      expect(req.headers['user-agent']).toBe(UA_142_LINUX);
      expect(req.headers['sec-ch-ua']).toContain('v="142"');
      expect(req.headers['sec-ch-ua-mobile']).toBe('?0');
      expect(req.headers['sec-ch-ua-platform']).toBe('"Linux"');
      expect(req.headers.referer).toBe('https://chat.qwen.ai/');
      expect(req.headers.cookie).toBe('token=T; acw_tc=A');
    }
  });
});
