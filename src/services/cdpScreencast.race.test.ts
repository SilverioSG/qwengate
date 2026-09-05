import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

type CookieResult = { cookies: Array<{ name: string; value: string; expires: number }> };

type Event = { at: number; name: string };

/**
 * Minimal deterministic model of the two success paths in cdpScreencast.ts.
 * It intentionally keeps the production ordering: polling starts first, then
 * only a persisted token emits success and schedules cleanup.
 */
class LoginRaceHarness {
  now = 0;
  closed = false;
  loginCompleted = false;
  loginCompletionInFlight = false;
  loginCompleteCount = 0;
  saveCookiesCount = 0;
  cleanupCount = 0;
  pollCancelledBeforePersistence = false;
  events: Event[] = [];
  private pollActive = true;
  private pendingCookie: { resolve: (result: CookieResult) => void; reject: () => void } | null = null;
  private timers: Array<{ at: number; callback: () => void }> = [];

  startLoginPolling(): void {
    this.schedule(2000, () => this.poll());
  }

  frameNavigated(): void {
    this.record('navigation');
  }

  resolveCookies(result: CookieResult): void {
    const pending = this.pendingCookie;
    this.pendingCookie = null;
    if (pending) pending.resolve(result);
  }

  rejectCookies(): void {
    const pending = this.pendingCookie;
    this.pendingCookie = null;
    if (pending) pending.reject();
  }

  advanceTo(at: number): void {
    assert.ok(at >= this.now);
    while (true) {
      const next = this.timers.filter((timer) => timer.at <= at).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers.splice(this.timers.indexOf(next), 1);
      this.now = next.at;
      next.callback();
    }
    this.now = at;
  }

  private poll(): void {
    if (this.closed || !this.pollActive) return;
    this.pendingCookie = {
      resolve: (result) => {
        const token = result.cookies.find((cookie) => cookie.name === 'token');
        if (!token || token.expires * 1000 <= this.now) return;
        if (this.loginCompleted || this.loginCompletionInFlight) return;
        this.loginCompletionInFlight = true;
        this.saveCookies();
        this.loginCompleted = true;
        this.loginCompleteCount++;
        this.record('login_complete');
        this.schedule(2000, () => this.cleanupSession());
      },
      reject: () => {
        this.pollCancelledBeforePersistence = true;
      },
    };
  }

  private saveCookies(): void {
    this.saveCookiesCount++;
    this.record('saveCookies');
  }

  private cleanupSession(): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanupCount++;
    this.pollActive = false;
    this.record('cleanupSession');
    if (this.pendingCookie) this.rejectCookies();
  }

  private schedule(delay: number, callback: () => void): void {
    this.timers.push({ at: this.now + delay, callback });
  }

  private record(name: string): void {
    this.events.push({ at: this.now, name });
  }
}

function tokenResult(): CookieResult {
  return { cookies: [{ name: 'token', value: 'synthetic-token', expires: 9_999_999_999 }] };
}

describe('embedded CDP login race reproduction', () => {
  test('A: frame navigation reports success while cookie polling has no token', () => {
    const harness = new LoginRaceHarness();
    harness.startLoginPolling();
    harness.advanceTo(500);
    harness.frameNavigated();
    harness.advanceTo(2500);

    assert.deepEqual(harness.events, [{ at: 500, name: 'navigation' }]);
    assert.equal(harness.loginCompleteCount, 0);
    assert.equal(harness.saveCookiesCount, 0);
    assert.equal(harness.cleanupCount, 0);
    assert.equal(harness.pollCancelledBeforePersistence, false);
  });

  test('B: token is available before cleanup and is persisted', () => {
    const harness = new LoginRaceHarness();
    harness.startLoginPolling();
    harness.advanceTo(500);
    harness.frameNavigated();
    harness.advanceTo(2100);
    harness.resolveCookies(tokenResult());
    harness.advanceTo(4100);

    assert.deepEqual(harness.events, [
      { at: 500, name: 'navigation' },
      { at: 2100, name: 'saveCookies' },
      { at: 2100, name: 'login_complete' },
      { at: 4100, name: 'cleanupSession' },
    ]);
    assert.equal(harness.loginCompleteCount, 1);
    assert.equal(harness.saveCookiesCount, 1);
    assert.equal(harness.cleanupCount, 1);
  });

  test('C: token appears just after the two-second cleanup deadline', () => {
    const harness = new LoginRaceHarness();
    harness.startLoginPolling();
    harness.advanceTo(500);
    harness.frameNavigated();
    harness.advanceTo(2000);
    harness.advanceTo(2501);
    harness.resolveCookies(tokenResult());
    harness.advanceTo(4501);

    assert.deepEqual(harness.events, [
      { at: 500, name: 'navigation' },
      { at: 2501, name: 'saveCookies' },
      { at: 2501, name: 'login_complete' },
      { at: 4501, name: 'cleanupSession' },
    ]);
    assert.equal(harness.saveCookiesCount, 1);
    assert.equal(harness.loginCompleteCount, 1);
    assert.equal(harness.cleanupCount, 1);
    assert.equal(harness.pollCancelledBeforePersistence, false);
  });

  test('D: pending Network.getCookies is cancelled when cleanup expires', () => {
    const harness = new LoginRaceHarness();
    harness.startLoginPolling();
    harness.advanceTo(500);
    harness.frameNavigated();
    harness.advanceTo(2500);

    assert.equal(harness.cleanupCount, 0);
    assert.equal(harness.saveCookiesCount, 0);
    assert.equal(harness.pollCancelledBeforePersistence, false);

    harness.resolveCookies(tokenResult());
    assert.equal(harness.saveCookiesCount, 1);
    assert.equal(harness.loginCompleteCount, 1);
    assert.equal(harness.cleanupCount, 0);
    assert.deepEqual(harness.events, [
      { at: 500, name: 'navigation' },
      { at: 2500, name: 'saveCookies' },
      { at: 2500, name: 'login_complete' },
    ]);
  });
});
