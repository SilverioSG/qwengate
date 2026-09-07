import { afterEach, describe, expect, test } from 'bun:test';
import { logStore } from './logStore.ts';
import { SessionPool } from './sessionPool.ts';

const originalMockPlaywright = process.env.TEST_MOCK_PLAYWRIGHT;
const originalSessionId = process.env.TEST_SESSION_ID;

afterEach(() => {
  if (originalMockPlaywright === undefined) delete process.env.TEST_MOCK_PLAYWRIGHT;
  else process.env.TEST_MOCK_PLAYWRIGHT = originalMockPlaywright;
  if (originalSessionId === undefined) delete process.env.TEST_SESSION_ID;
  else process.env.TEST_SESSION_ID = originalSessionId;
});

describe('SessionPool temporary instrumentation', () => {
  test('creates active metadata on acquire', async () => {
    process.env.TEST_MOCK_PLAYWRIGHT = '1';
    process.env.TEST_SESSION_ID = 'instrument-acquire';
    const pool = new SessionPool();

    await pool.acquire(undefined, 'test_acquire');

    const details = pool.getStats().activeDetails;
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      chatId: 'instrument-acquire',
      accountEmail: 'mock@test',
      acquirePath: 'test_acquire',
    });
    expect(details[0].acquiredAt).toBeGreaterThan(0);
    expect(details[0].acquireCaller).toContain('sessionPool.instrumentation.test.ts');
  });

  test('removes metadata and is idempotent on release', async () => {
    process.env.TEST_MOCK_PLAYWRIGHT = '1';
    process.env.TEST_SESSION_ID = 'instrument-release';
    const pool = new SessionPool();
    await pool.acquire(undefined, 'test_acquire');

    await pool.release('instrument-release', null, undefined, 'mock@test', false, 'test_release');
    expect(pool.getStats().activeDetails).toHaveLength(0);
    expect(pool.getStats()).toMatchObject({ total: 0, inUse: 0 });

    await pool.release('instrument-release', null, undefined, 'mock@test', false, 'duplicate_release');
    expect(pool.getStats()).toMatchObject({ total: 0, inUse: 0 });
  });

  test('ageMs grows while the session remains active', async () => {
    process.env.TEST_MOCK_PLAYWRIGHT = '1';
    process.env.TEST_SESSION_ID = 'instrument-age';
    const pool = new SessionPool();
    await pool.acquire(undefined, 'test_acquire');
    const firstAge = pool.getStats().activeDetails[0].ageMs;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondAge = pool.getStats().activeDetails[0].ageMs;

    expect(secondAge).toBeGreaterThanOrEqual(firstAge);
  });

  test('records the release path in the release log', async () => {
    process.env.TEST_MOCK_PLAYWRIGHT = '1';
    process.env.TEST_SESSION_ID = 'instrument-release-order';
    const pool = new SessionPool();
    await pool.acquire(undefined, 'test_acquire');
    const messages: string[] = [];
    const originalLog = logStore.log;
    logStore.log = ((level: any, category: any, message: string) => {
      if (category === 'pool') messages.push(message);
      return originalLog.call(logStore, level, category, message);
    }) as typeof logStore.log;
    try {
      await pool.release('instrument-release-order', null, undefined, 'mock@test', false, 'test_release_order');
    } finally {
      logStore.log = originalLog;
    }
    expect(messages.some((message) => message.includes('path=test_release_order'))).toBe(true);
    expect(pool.getStats().activeDetails).toHaveLength(0);
  });
});
