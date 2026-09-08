import { describe, expect, test } from 'bun:test';
import { buildModelsRequest, MODELS_CLIENT_HINTS } from './qwenModels.ts';

const UA_142_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

describe('models canonical request (WAF regression)', () => {
  test('user-agent is present and passed through', () => {
    const req = buildModelsRequest('token=T', UA_142_LINUX);
    expect(req.headers['user-agent']).toBe(UA_142_LINUX);
  });

  test('sec-ch-ua is present', () => {
    const req = buildModelsRequest('token=T', UA_142_LINUX);
    expect(req.headers['sec-ch-ua']).toContain('Chromium');
    expect(req.headers['sec-ch-ua']).toBe(MODELS_CLIENT_HINTS['sec-ch-ua']);
  });

  test('sec-ch-ua-mobile is present', () => {
    const req = buildModelsRequest('token=T', UA_142_LINUX);
    expect(req.headers['sec-ch-ua-mobile']).toBe('?0');
  });

  test('sec-ch-ua-platform is present', () => {
    const req = buildModelsRequest('token=T', UA_142_LINUX);
    expect(req.headers['sec-ch-ua-platform']).toBe('"Linux"');
  });

  test('declared profile is coherent (UA major == sec-ch-ua major, platform == UA OS)', () => {
    const req = buildModelsRequest('token=T', UA_142_LINUX);
    const uaMajor = UA_142_LINUX.match(/Chrome\/(\d+)/)?.[1];
    expect(uaMajor).toBe('142');
    expect(req.headers['sec-ch-ua']).toContain(`v="${uaMajor}"`);
    expect(req.headers['sec-ch-ua-platform']).toBe('"Linux"');
    expect(req.headers['user-agent']).toContain('X11; Linux x86_64');
  });

  test('rest of the request is unchanged (method, url, base headers)', () => {
    const req = buildModelsRequest('token=T', UA_142_LINUX);
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://chat.qwen.ai/api/models');
    expect(req.headers.accept).toBe('application/json, text/plain, */*');
    expect(req.headers.source).toBe('web');
    expect(req.headers.origin).toBe('https://chat.qwen.ai');
    expect(req.headers.referer).toBe('https://chat.qwen.ai/');
  });

  test('cookie logic unchanged (token passthrough, empty stays absent)', () => {
    expect(buildModelsRequest('token=T', UA_142_LINUX).headers.cookie).toBe('token=T');
    expect(buildModelsRequest('', UA_142_LINUX).headers).not.toHaveProperty('cookie');
  });

  test('builder adds no bx-* headers (bx stays in browserlessFetch)', () => {
    const req = buildModelsRequest('token=T', UA_142_LINUX);
    for (const k of Object.keys(req.headers)) {
      expect(k.startsWith('bx-')).toBe(false);
    }
  });
});
