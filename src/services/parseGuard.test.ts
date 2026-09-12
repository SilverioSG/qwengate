import { describe, expect, test } from 'bun:test';
import { isParseGuardOpenError, isParseWafFailure, ParseGuard, ParseGuardOpenError } from './parseGuard.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wafErr = () => new Error('parseFile failed: WAF challenge persists after cookie refresh');

describe('parseGuard', () => {
  test('max inflight=1 con 6 requests simultáneas', async () => {
    const g = new ParseGuard({ pacingMs: 0, breakerCooldownMs: 10_000 });
    let current = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        g.execute(async () => {
          current++;
          peak = Math.max(peak, current);
          await sleep(10);
          current--;
        }),
      ),
    );
    expect(peak).toBe(1);
    expect(g.getMetrics().parse_inflight).toBe(0);
  });

  test('FIFO: orden de concesión = orden de llegada', async () => {
    const g = new ParseGuard({ pacingMs: 0 });
    const order: number[] = [];
    const first = g.execute(async () => {
      await sleep(30);
    });
    const rest = [1, 2, 3].map((i) =>
      g.execute(async () => {
        order.push(i);
      }),
    );
    await Promise.all([first, ...rest]);
    expect(order).toEqual([1, 2, 3]);
  });

  test('pacing mínimo entre inicios', async () => {
    const g = new ParseGuard({ pacingMs: 60 });
    const starts: number[] = [];
    await Promise.all(
      [0, 1].map(() =>
        g.execute(async () => {
          starts.push(Date.now());
        }),
      ),
    );
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(50);
  });

  test('WAF abre breaker; cooldown lleva a HALF_OPEN; PASS cierra', async () => {
    const g = new ParseGuard({ pacingMs: 0, breakerCooldownMs: 60 });
    await expect(g.execute(async () => {
      throw wafErr();
    })).rejects.toThrow(/WAF/);
    expect(g.getMetrics().breaker_state).toBe('OPEN');
    expect(g.getMetrics().parse_waf_events_total).toBe(1);
    await expect(g.execute(async () => {})).rejects.toBeInstanceOf(ParseGuardOpenError);
    await sleep(80);
    await g.execute(async () => {});
    expect(g.getMetrics().breaker_state).toBe('CLOSED');
  });

  test('HALF_OPEN permite una sola sonda; WAF en sonda reabre', async () => {
    const g = new ParseGuard({ pacingMs: 0, breakerCooldownMs: 40 });
    await expect(g.execute(async () => {
      throw wafErr();
    })).rejects.toThrow();
    await sleep(60);
    const results = await Promise.allSettled([
      g.execute(async () => {
        await sleep(30);
      }),
      g.execute(async () => {}),
      g.execute(async () => {}),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(2);
    expect(g.getMetrics().half_open_probe_total).toBe(1);
    expect(g.getMetrics().breaker_state).toBe('CLOSED');
    // Nuevo WAF -> OPEN otra vez; la siguiente sonda con WAF reabre y marca waf-fail.
    await expect(g.execute(async () => {
      throw wafErr();
    })).rejects.toThrow();
    expect(g.getMetrics().breaker_state).toBe('OPEN');
    await sleep(60);
    await expect(g.execute(async () => {
      throw wafErr();
    })).rejects.toThrow();
    expect(g.getMetrics().breaker_state).toBe('OPEN');
    expect(g.getMetrics().half_open_probe_total).toBe(2);
    expect(g.getMetrics().half_open_probe_result).toBe('waf-fail');
  });

  test('error no-WAF no abre breaker y libera slot', async () => {
    const g = new ParseGuard({ pacingMs: 0 });
    await expect(g.execute(async () => {
      throw new Error('OSS upload failed: 500');
    })).rejects.toThrow(/OSS/);
    expect(g.getMetrics().breaker_state).toBe('CLOSED');
    expect(g.getMetrics().parse_waf_events_total).toBe(0);
    await g.execute(async () => {});
    expect(g.getMetrics().parse_inflight).toBe(0);
  });

  test('flag OFF conserva comportamiento previo (sin cola ni pacing)', async () => {
    const g = new ParseGuard({ enabled: false, pacingMs: 5000 });
    let current = 0;
    let peak = 0;
    const t0 = Date.now();
    await Promise.all(
      [0, 1].map(() =>
        g.execute(async () => {
          current++;
          peak = Math.max(peak, current);
          await sleep(10);
          current--;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('abort/error libera slot para el siguiente', async () => {
    const g = new ParseGuard({ pacingMs: 0 });
    await expect(g.execute(async () => {
      throw new Error('boom');
    })).rejects.toThrow(/boom/);
    let ran = false;
    await g.execute(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(g.getMetrics().parse_queue_depth).toBe(0);
  });

  test('helpers de clasificación', () => {
    expect(isParseWafFailure(new Error('WAF challenge persists after cookie refresh'))).toBe(true);
    expect(isParseWafFailure(new Error('parseFile failed: 403'))).toBe(false);
    expect(isParseWafFailure(new Error('OSS upload failed: 500'))).toBe(false);
    expect(isParseGuardOpenError(new ParseGuardOpenError())).toBe(true);
    expect(isParseGuardOpenError(new Error('x'))).toBe(false);
  });
});
