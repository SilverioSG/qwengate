import { describe, expect, test } from 'bun:test';

const browserlessSource = await Bun.file(new URL('./browserlessFetch.ts', import.meta.url)).text();
const fireyejsSource = await Bun.file(new URL('./fireyejsRunner.ts', import.meta.url)).text();

describe('WAF recovery regression specifications', () => {
  test('replaces stale acw_tc without duplicating it', () => {
    expect(browserlessSource).toContain("filter((cookie) => !cookie.startsWith(`${name}=`))");
    expect(browserlessSource).toContain("replaceCookie(headers, 'acw_tc', freshAcwTc)");
  });

  test('performs the HTTP refresh retry before Playwright', () => {
    const refresh = browserlessSource.indexOf("replaceCookie(headers, 'acw_tc', freshAcwTc)");
    const httpRetry = browserlessSource.indexOf("logFetchCall('browserlessFetch.http-refresh'");
    const playwright = browserlessSource.indexOf('refreshCookiesViaBrowser(currentCookie, url)');

    expect(refresh).toBeGreaterThanOrEqual(0);
    expect(httpRetry).toBeGreaterThan(refresh);
    expect(playwright).toBeGreaterThan(httpRetry);
    expect(browserlessSource).toContain('if (!wafCheck(refreshedResponse)) return refreshedResponse;');
  });

  test('preserves cookie scope and filters cookies for the request URL', () => {
    expect(fireyejsSource).toContain('domain?: string;');
    expect(fireyejsSource).toContain('path?: string;');
    expect(fireyejsSource).toContain('function cookieMatchesUrl');
    expect(fireyejsSource).toContain('freshCookies.filter((cookie: BrowserRefreshCookie) => cookieMatchesUrl(cookie, requestUrl))');
    expect(fireyejsSource).not.toContain('cookieMap.set(c.name, c.value)');
  });

  test('rejects Playwright recovery while the WAF challenge remains', () => {
    const challengeCheck = fireyejsSource.indexOf('if (challengePresent)');
    const cookieRead = fireyejsSource.indexOf('const freshCookies = await page.context().cookies()');

    expect(challengeCheck).toBeGreaterThanOrEqual(0);
    expect(challengeCheck).toBeLessThan(cookieRead);
    expect(fireyejsSource).toContain('return null;');
  });
});
