/**
 * parseGuard — protección mínima del pipeline STS -> OSS -> /files/parse.
 *
 * - Guard global: max 1 pipeline en vuelo, cola FIFO con profundidad y
 *   espera máximas, pacing mínimo entre inicios.
 * - Circuit breaker global para WAF de parse: CLOSED / OPEN / HALF_OPEN
 *   con cooldown y una sola sonda en HALF_OPEN.
 * - Mientras OPEN: rechazo inmediato sin tocar upstream (sin sts/oss/parse
 *   nuevos, sin retries, sin rotación ni refresh inducidos por el pipeline).
 * - Feature flag PARSE_GUARD_ENABLED (defecto true). OFF = comportamiento previo.
 * - Solo cubre pipelines que llegan a parse (ficheros); imágenes lo omiten.
 */

import { config } from './configService.ts';
import { logStore } from './logStore.ts';

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface ParseGuardMetrics {
  parse_inflight: number;
  parse_queue_depth: number;
  parse_waf_events_total: number;
  breaker_state: BreakerState;
  cooldown_remaining_ms: number;
  half_open_probe_total: number;
  half_open_probe_result: 'pass' | 'waf-fail' | null;
}

export interface ParseGuardOptions {
  enabled?: boolean;
  maxConcurrency?: number;
  pacingMs?: number;
  breakerCooldownMs?: number;
  maxQueueDepth?: number;
  maxQueueWaitMs?: number;
}

export class ParseGuardOpenError extends Error {
  readonly code = 'PARSE_GUARD_OPEN';
  constructor(message = 'parse pipeline blocked: breaker OPEN') {
    super(message);
    this.name = 'ParseGuardOpenError';
  }
}

export function isParseGuardOpenError(err: unknown): boolean {
  return err instanceof ParseGuardOpenError || (err as any)?.code === 'PARSE_GUARD_OPEN';
}

/** Clasifica un fallo como WAF de parse (conservador: solo firma WAF explícita). */
export function isParseWafFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /waf|aliyun_waf|persists after cookie refresh/i.test(msg);
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

function readInt(key: 'PARSE_MAX_CONCURRENCY' | 'PARSE_PACING_MS' | 'PARSE_BREAKER_COOLDOWN_MS' | 'PARSE_MAX_QUEUE_DEPTH' | 'PARSE_MAX_QUEUE_WAIT_MS', fallback: number): number {
  // config.get prioriza env sobre fichero y defaults (ver configService).
  const val = config.getInt(key, fallback);
  return Number.isFinite(val) && val >= 0 ? val : fallback;
}

export class ParseGuard {
  private inflight = 0;
  private queue: Waiter[] = [];
  private lastStartAt = 0;
  private lastParsePostAt = 0;
  private breaker: BreakerState = 'CLOSED';
  private openedAt = 0;
  private halfOpenInFlight = false;
  private wafEventsTotal = 0;
  private halfOpenProbeTotal = 0;
  private halfOpenProbeResult: 'pass' | 'waf-fail' | null = null;

  constructor(private readonly opts: ParseGuardOptions = {}) {}

  get enabled(): boolean {
    if (this.opts.enabled !== undefined) return this.opts.enabled;
    return config.getBool('PARSE_GUARD_ENABLED', true);
  }

  private get maxConcurrency(): number {
    return this.opts.maxConcurrency ?? readInt('PARSE_MAX_CONCURRENCY', 1);
  }

  private get pacingMs(): number {
    return this.opts.pacingMs ?? readInt('PARSE_PACING_MS', 2000);
  }

  private get breakerCooldownMs(): number {
    return this.opts.breakerCooldownMs ?? readInt('PARSE_BREAKER_COOLDOWN_MS', 60000);
  }

  private get maxQueueDepth(): number {
    return this.opts.maxQueueDepth ?? readInt('PARSE_MAX_QUEUE_DEPTH', 20);
  }

  private get maxQueueWaitMs(): number {
    return this.opts.maxQueueWaitMs ?? readInt('PARSE_MAX_QUEUE_WAIT_MS', 120000);
  }

  getMetrics(): ParseGuardMetrics {
    return {
      parse_inflight: this.inflight,
      parse_queue_depth: this.queue.length,
      parse_waf_events_total: this.wafEventsTotal,
      breaker_state: this.breaker,
      cooldown_remaining_ms:
        this.breaker === 'OPEN' ? Math.max(0, this.openedAt + this.breakerCooldownMs - Date.now()) : 0,
      half_open_probe_total: this.halfOpenProbeTotal,
      half_open_probe_result: this.halfOpenProbeResult,
    };
  }

  private openBreaker(reason: string): void {
    this.breaker = 'OPEN';
    this.openedAt = Date.now();
    this.halfOpenInFlight = false;
    logStore.log('warn', 'parse-guard', `breaker OPEN (${reason}) cooldown=${this.breakerCooldownMs}ms`);
  }

  private closeBreaker(): void {
    if (this.breaker !== 'CLOSED') {
      logStore.log('info', 'parse-guard', 'breaker CLOSED');
    }
    this.breaker = 'CLOSED';
    this.halfOpenInFlight = false;
  }

  private rejectWaiting(err: Error): void {
    const pending = this.queue.splice(0, this.queue.length);
    for (const w of pending) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private pump(): void {
    while (this.queue.length > 0 && this.inflight < this.maxConcurrency) {
      const waiter = this.queue.shift()!;
      if (Date.now() - waiter.enqueuedAt >= this.maxQueueWaitMs) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`parse pipeline queue wait exceeded ${this.maxQueueWaitMs}ms`));
        continue;
      }
      const waitPacing = Math.max(0, this.lastStartAt + this.pacingMs - Date.now());
      this.inflight++;
      this.lastStartAt = Date.now() + waitPacing;
      clearTimeout(waiter.timer);
      if (waitPacing > 0) {
        const resolve = waiter.resolve;
        setTimeout(resolve, waitPacing).unref?.();
      } else {
        waiter.resolve();
      }
      logStore.log(
        'debug',
        'parse-guard',
        `slot granted inflight=${this.inflight} queue=${this.queue.length} pacing_wait=${waitPacing}ms`,
      );
    }
  }

  private releaseSlot(): void {
    if (this.inflight > 0) this.inflight--;
    this.pump();
  }

  /**
   * Pacing global para CADA POST real a /api/v2/files/parse (mismo presupuesto
   * pacingMs, mismo mecanismo — sin segundo limitador):
   * - parse inicial del pipeline
   * - reintentos refresh/retry in-slot de browserlessFetch
   * - rotación externa (nuevo pipeline)
   * - half-open probe
   * Llamar inmediatamente antes de emitir el POST. No adquiere slot (espera
   * pura por timestamp): seguro dentro de un slot guardado, sin deadlock.
   * El sondeo /parse/status NO pasa por aquí (no es parse real).
   */
  async paceParsePost(): Promise<void> {
    if (!this.enabled) return;
    const wait = Math.max(0, this.lastParsePostAt + this.pacingMs - Date.now());
    if (wait > 0) {
      logStore.log('debug', 'parse-guard', `parse-post pacing wait=${wait}ms`);
      await new Promise<void>((r) => setTimeout(r, wait));
    }
    this.lastParsePostAt = Date.now();
  }

  /**
   * Ejecuta fn bajo guard + breaker. Clasifica WAF solo por firma explícita;
   * cualquier otro error libera el slot sin tocar el breaker.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();

    // --- Breaker ---
    if (this.breaker === 'OPEN') {
      if (Date.now() - this.openedAt >= this.breakerCooldownMs) {
        this.breaker = 'HALF_OPEN';
        logStore.log('info', 'parse-guard', 'breaker HALF_OPEN (cooldown elapsed, single probe allowed)');
      } else {
        throw new ParseGuardOpenError();
      }
    }
    let isProbe = false;
    if (this.breaker === 'HALF_OPEN') {
      if (this.halfOpenInFlight) throw new ParseGuardOpenError('parse pipeline blocked: half-open probe in flight');
      this.halfOpenInFlight = true;
      isProbe = true;
      this.halfOpenProbeTotal++;
    }

    // --- Cola FIFO ---
    if (this.inflight >= this.maxConcurrency) {
      if (this.queue.length >= this.maxQueueDepth) {
        if (isProbe) this.halfOpenInFlight = false;
        throw new Error(`parse pipeline queue full (depth=${this.maxQueueDepth})`);
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = this.queue.findIndex((w) => w.reject === reject);
          if (idx >= 0) this.queue.splice(idx, 1);
          if (isProbe) this.halfOpenInFlight = false;
          reject(new Error(`parse pipeline queue wait exceeded ${this.maxQueueWaitMs}ms`));
        }, this.maxQueueWaitMs);
        if (typeof timer.unref === 'function') timer.unref();
        this.queue.push({ resolve, reject, enqueuedAt: Date.now(), timer });
      });
    } else {
      const waitPacing = Math.max(0, this.lastStartAt + this.pacingMs - Date.now());
      this.inflight++;
      this.lastStartAt = Date.now() + waitPacing;
      if (waitPacing > 0) await new Promise<void>((r) => setTimeout(r, waitPacing));
    }

    try {
      const result = await fn();
      if (isProbe) {
        this.halfOpenProbeResult = 'pass';
        this.closeBreaker();
      }
      return result;
    } catch (err) {
      if (isParseWafFailure(err)) {
        this.wafEventsTotal++;
        if (isProbe) this.halfOpenProbeResult = 'waf-fail';
        this.openBreaker(isProbe ? 'waf on half-open probe' : 'waf failure');
        // Falla rápido el resto de la cola: sin reintentos inducidos durante OPEN.
        if (!isProbe) this.rejectWaiting(new ParseGuardOpenError());
      } else if (isProbe) {
        // Error no-WAF en sonda: fail-safe, volver a OPEN con cooldown nuevo.
        this.halfOpenProbeResult = 'waf-fail';
        this.openBreaker('non-waf probe error (fail-safe)');
      }
      throw err;
    } finally {
      if (isProbe) this.halfOpenInFlight = false;
      this.releaseSlot();
    }
  }
}

export const parseGuard = new ParseGuard();
