import { describe, expect, test } from 'bun:test';
import { isRealParsePost } from './browserlessFetch.ts';
import { ParseGuard } from './parseGuard.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('parse-post pacing (global por POST real a /parse)', () => {
  test('primer POST no espera; segundo respeta pacingMs', async () => {
    const g = new ParseGuard({ pacingMs: 80 });
    const t0 = Date.now();
    await g.paceParsePost();
    expect(Date.now() - t0).toBeLessThan(50);
    await g.paceParsePost();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  });

  test('reintentos in-slot del mismo pipeline también se pacean', async () => {
    const g = new ParseGuard({ pacingMs: 80 });
    const posts: number[] = [];
    await g.execute(async () => {
      await g.paceParsePost();
      posts.push(Date.now());
      await g.paceParsePost(); // retry refresh in-slot
      posts.push(Date.now());
      await g.paceParsePost(); // retry post-playwright in-slot
      posts.push(Date.now());
    });
    expect(posts[1] - posts[0]).toBeGreaterThanOrEqual(70);
    expect(posts[2] - posts[1]).toBeGreaterThanOrEqual(70);
  });

  test('pipelines secuenciales (rotación) heredan el pacing por POST', async () => {
    const g = new ParseGuard({ pacingMs: 80 });
    const posts: number[] = [];
    await g.execute(async () => {
      await g.paceParsePost();
      posts.push(Date.now());
    });
    await g.execute(async () => {
      await g.paceParsePost();
      posts.push(Date.now());
    });
    expect(posts[1] - posts[0]).toBeGreaterThanOrEqual(70);
  });

  test('probe half-open también pacea su POST', async () => {
    const g = new ParseGuard({ pacingMs: 80, breakerCooldownMs: 30 });
    await g.paceParsePost();
    const t0 = Date.now();
    await expect(
      g.execute(async () => {
        await g.paceParsePost();
        throw new Error('parseFile failed: WAF challenge persists after cookie refresh');
      }),
    ).rejects.toThrow(/WAF/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
    expect(g.getMetrics().breaker_state).toBe('OPEN');
  });

  test('guard deshabilitado no espera', async () => {
    const g = new ParseGuard({ enabled: false, pacingMs: 5000 });
    const t0 = Date.now();
    await g.paceParsePost();
    await g.paceParsePost();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('isRealParsePost solo coincide con el trigger exacto', () => {
    expect(isRealParsePost('https://chat.qwen.ai/api/v2/files/parse', 'POST')).toBe(true);
    expect(isRealParsePost('https://chat.qwen.ai/api/v2/files/parse?x=1', 'POST')).toBe(true);
    expect(isRealParsePost('https://chat.qwen.ai/api/v2/files/parse/status', 'POST')).toBe(false);
    expect(isRealParsePost('https://chat.qwen.ai/api/v2/files/parse', 'GET')).toBe(false);
    expect(isRealParsePost('https://chat.qwen.ai/api/v2/chats/new', 'POST')).toBe(false);
    expect(isRealParsePost('https://chat.qwen.ai/api/v2/files/getstsToken', 'POST')).toBe(false);
  });

  test('status-poll no consume presupuesto de pacing', async () => {
    const g = new ParseGuard({ pacingMs: 200 });
    await g.paceParsePost();
    await sleep(10);
    // isRealParsePost(status) === false → sin espera inducida; verificación directa:
    expect(isRealParsePost('https://chat.qwen.ai/api/v2/files/parse/status', 'POST')).toBe(false);
  });
});
