import { describe, expect, test } from 'bun:test';
import type { BasicHeaders } from './playwright.ts';
import { buildChatsNewRequest, getChatsNewTimezone, mergeChatsNewCookies } from './sessionPool.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const baseHeaders: BasicHeaders = {
  cookie: 'cna=AAA; acw_tc=BBB; token=OLD; isg=CCC',
  userAgent: 'UA-142',
  bxV: '2.5.36',
  bxUmidtoken: '',
  bxUa: '',
};

describe('chats/new canonical request', () => {
  test('body contains chatId and no title', () => {
    const req = buildChatsNewRequest(baseHeaders, { token: 'NEW', flagship: true, now: 123 });
    const body = JSON.parse(req.body);
    expect(body.chatId).toBe('');
    expect(body).not.toHaveProperty('title');
    expect(body.models).toEqual(['qwen3.7-plus']);
    expect(body.project_id).toBe('');
    expect(body.chat_type).toBe('t2t');
    expect(body.timestamp).toBe(123);
  });

  test('non-flagship account falls back to flash model', () => {
    const req = buildChatsNewRequest(baseHeaders, { token: null, flagship: false, now: 1 });
    expect(JSON.parse(req.body).models).toEqual(['qwen3.5-flash']);
  });

  test('cookie merges session cookies with fresh token without duplicates', () => {
    expect(mergeChatsNewCookies('a=1; token=OLD; b=2', 'NEW')).toBe('token=NEW; a=1; b=2');
    expect(mergeChatsNewCookies('', 'NEW')).toBe('token=NEW');
    expect(mergeChatsNewCookies('a=1', null)).toBe('a=1');
  });

  test('request cookie preserves session and carries a single fresh token', () => {
    const req = buildChatsNewRequest(baseHeaders, { token: 'NEW', flagship: true });
    const names = req.headers.cookie.split(';').map((c) => c.trim().split('=')[0]);
    expect(names.filter((n) => n === 'token')).toHaveLength(1);
    expect(req.headers.cookie).toContain('token=NEW');
    expect(req.headers.cookie).toContain('acw_tc=BBB');
    expect(req.headers.cookie).not.toContain('token=OLD');
  });

  test('referer points at /c/new-chat', () => {
    const req = buildChatsNewRequest(baseHeaders, { token: 'T', flagship: true });
    expect(req.headers.referer.endsWith('/c/new-chat')).toBe(true);
  });

  test('x-request-id is present and a valid UUID', () => {
    const req = buildChatsNewRequest(baseHeaders, { token: 'T', flagship: true });
    expect(req.headers['x-request-id']).toMatch(UUID_RE);
  });

  test('BasicHeaders are preserved, not discarded', () => {
    const req = buildChatsNewRequest(baseHeaders, { token: 'T', flagship: true });
    expect(req.headers['user-agent']).toBe('UA-142');
    expect(req.headers['sec-ch-ua']).toContain('Chromium');
    expect(req.headers['sec-ch-ua-mobile']).toBe('?0');
    expect(req.headers['sec-ch-ua-platform']).toBe('"Linux"');
    expect(req.headers['accept-language']).toBe('en-US,en;q=0.9');
    expect(req.headers.timezone).toMatch(/GMT[+-]\d{4}/);
    expect(req.headers['bx-v']).toBe('2.5.36');
  });

  test('bx-pp and bx-et are never added', () => {
    const req = buildChatsNewRequest(baseHeaders, { token: 'T', flagship: true });
    expect(req.headers).not.toHaveProperty('bx-pp');
    expect(req.headers).not.toHaveProperty('bx-et');
  });

  test('timezone matches the SPA runtime format', () => {
    expect(getChatsNewTimezone()).toMatch(/^[A-Za-z]{3} [A-Za-z]{3} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}$/);
  });
});
