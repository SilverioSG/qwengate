# Incident: quota_limit PRE-EMISSION MID-STREAM

## INCIDENT

`quota_limit` visible al cliente aunque había cuentas alternativas elegibles y
nada se había emitido todavía.

## ROOT_CAUSE

First chunk sano (`response.created`, sin contenido) + `quota_limit` posterior
en chunk 2..N + `hasEmittedContent=false` + sin `tool_call` emitido → no
existía handoff en ese path (`HANDOFF_ATTEMPTED=NO`, error propagado).

El bug histórico de pérdida del código semántico estaba ya cerrado
(`data.error.code` se preserva); SessionPool no bloqueaba el failover
(`AVAILABLE=0` es su estado normal: sesiones efímeras, sin límite fijo).

## FIX

Handoff A→B pre-emission mid-stream, máximo 1 handoff/request
(`MAX_MIDSTREAM_QUOTA_HANDOFFS=1` en `src/routes/streamLoop.ts`):

- Solo cuando `upstreamCode` es `quota_limit` o equivalente `RateLimited`
  (paridad con first-chunk/mid-body), `hasEmittedContent=false` y
  `emittedToolCallCount=0` (`getRetryablePreEmissionQuota`).
- A se libera/detach correctamente (reader cancelado, upstream abortado,
  `sessionPool.release(..., false)`), heartbeat y writer del cliente intactos.
- B se adquiere excluyendo A (`acquireNextSession`, `setupSession(...,
  initialExcludeEmail)`); el error de A se retira del request-log para no
  envenenar el monitor.
- Sin alternativa elegible → error terminal controlado, sin loop.
- `RateLimited` reporta wall (como first-chunk/mid-body); `quota_limit` no
  throttlea (preservado por test).

## NO CAMBIADO

- first-chunk behavior
- post-emission behavior (nunca mezcla streams A+B)
- SessionPool
- throttling semantics
- idle timeout
- CAPTCHA
- semantic code parsing
- dashboard / model health

## Archivos

- `src/routes/streamLoop.ts` — detector + presupuesto MAX 1.
- `src/routes/chatStreaming.ts` — loop de intentos sobre el mismo writer.
- `src/routes/chat.ts` — `initialExcludeEmail` + factory `acquireNextSession`.
- `src/tests/index.test.ts` — tests MID-STREAM B–G
  (A first-chunk ya cubierto por tests previos).

## VALIDATION

- TARGETED_TESTS=PASS (MID-STREAM 6/6, quota_limit 10/10)
- FULL_SUITE=277/277 PASS
- TYPECHECK=PASS (`tsc --noEmit`)
- RUNTIME_VALIDATION=PASS (restart limpio, smoke non-stream+stream, agentic
  3 tool_calls → 3 tool_results → respuesta grounded)
- NEW_REGRESSIONS=0
- LIVE_NATURAL_QUOTA_VALIDATION=PENDING (sin quota natural en la ventana;
  no se forzó)

## FINAL CLOSURE

- INCIDENT=quota_limit PRE-EMISSION MID-STREAM → CLOSED
- FIX_COMMIT=5f7cb1cc6774e25c208d63967e010a84fa824dc3
- TEST_VALIDATION=PASS (277/277, tsc, diff-check)
- RUNTIME_VALIDATION=PASS (smoke + agentic 3×tool/3×result grounded)
- REMOTE_PUSH=PASS, HEAD_EQUALS_ORIGIN_MAIN=YES
- DASHBOARD_BASELINE_RESET=PASS (monitor/usage reseteados con backup
  preservado; smoke post-reset 200/stop, 1 request / 0 errores)
- LIVE_NATURAL_QUOTA_VALIDATION=PASSIVE_MONITORING (no blocker):
  el próximo quota_limit natural debe confirmar
  ERROR_PHASE=MIDSTREAM_PREEMISSION, HANDOFF_ATTEMPTED=YES,
  HANDOFF_SUCCESS=YES, ERROR_PROPAGATED_TO_CLIENT=NO.
